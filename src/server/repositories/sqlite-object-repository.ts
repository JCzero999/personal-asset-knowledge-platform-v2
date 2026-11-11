import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import {
  isLibrary,
  isWorkFormat,
  isWorkStatus,
  type BusinessObject,
  type WorkFormat,
  type WorkStatus,
} from "../../domain/objects";
import { ConflictError, DomainError, NotFoundError, ValidationError } from "../../domain/errors";
import { assertTransition } from "../../domain/workflow";
import type { AppDatabase } from "../db/client";
import { ulid } from "../db/id";
import { translateSqliteError } from "./sqlite-errors";
import {
  libraryEvents,
  objects,
  syncJobs,
  type LibraryEventRow,
  type NewObjectRow,
  type ObjectRow,
} from "../db/schema";
import type {
  ChangeLibraryInput,
  ChangeStatusInput,
  CreateObjectInput,
  LibraryChangeEvent,
  ListObjectsQuery,
  ObjectRepository,
  UpdateObjectInput,
} from "../ports/object-repository";

/** better-sqlite3 事务里的 drizzle 句柄，仅供同步写入使用。 */
type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

/**
 * 元数据变化即入队：RAGFlow 侧 `meta_fields` 依赖这条任务刷新。
 * 同一对象同一动作至多一条活跃任务，重复入队由 sync_jobs_active_uq 吞掉。
 */
function enqueueSyncJob(
  tx: Tx,
  ownerType: "asset" | "work",
  ownerId: string,
  action: "upsert" | "delete",
  now: string,
): void {
  tx.insert(syncJobs)
    .values({
      id: ulid(),
      ownerType,
      ownerId,
      contentRefId: null,
      action,
      state: "pending",
      attempts: 0,
      lastError: null,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}

/**
 * `ObjectRepository` 的 SQLite 实现。
 *
 * 约定：
 * - 所有写入走单条 SQL 或事务，读-改-写用 revision 做乐观锁；
 * - 数据库 CHECK 约束是最后防线，失败时翻译成带错误码的 DomainError；
 * - 时间字段一律由调用方或统一 now() 注入，避免领域层依赖时钟。
 */

function nowIso(): string {
  return new Date().toISOString();
}

/** LIKE 通配符按字面量匹配，避免用户输入的 % / _ 扩大搜索范围。 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function toObject(row: ObjectRow): BusinessObject {
  const base = {
    id: row.id,
    title: row.title,
    description: row.description,
    library: row.library as BusinessObject["library"],
    source: row.source as BusinessObject["source"],
    origin: row.origin as BusinessObject["origin"],
    primaryCategory: row.primaryCategory,
    categories: row.categories ?? [],
    tags: row.tags ?? [],
    priority: row.priority as BusinessObject["priority"],
    archivedAt: row.archivedAt,
    libraryChangedAt: row.libraryChangedAt,
    ownerSub: row.ownerSub,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };

  if (row.type === "work") {
    return {
      ...base,
      type: "work",
      format: row.format as WorkFormat,
      status: row.status as WorkStatus,
      sourceNote: row.sourceNote,
    };
  }

  return {
    ...base,
    type: "asset",
    format: null,
    status: null,
    sourceNote: null,
  };
}

function toLibraryEvent(row: LibraryEventRow): LibraryChangeEvent {
  return {
    id: row.id,
    objectId: row.objectId,
    fromLibrary: row.fromLibrary as LibraryChangeEvent["fromLibrary"],
    toLibrary: row.toLibrary as LibraryChangeEvent["toLibrary"],
    reason: row.reason,
    actorSub: row.actorSub,
    createdAt: row.createdAt,
  };
}

export class SqliteObjectRepository implements ObjectRepository {
  constructor(private readonly db: AppDatabase) {}

  async create(input: CreateObjectInput): Promise<BusinessObject> {
    const now = input.now ?? nowIso();
    const categories = [...(input.categories ?? [])];
    const isWork = input.type === "work";

    if (!isWork && (input.format ?? input.sourceNote) != null) {
      throw new ValidationError("资产不允许携带 format / sourceNote", {
        type: input.type,
      });
    }

    if (isWork && !isWorkFormat(input.format)) {
      throw new ValidationError("作品必须提供合法的 format", { format: input.format });
    }

    const row: NewObjectRow = {
      id: input.id ?? ulid(),
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      library: input.library,
      source: input.source ?? "handwritten",
      origin: input.origin ?? "self",
      primaryCategory: categories[0] ?? null,
      categories,
      tags: [...(input.tags ?? [])],
      priority: input.priority ?? "medium",
      archivedAt: null,
      libraryChangedAt: null,
      ownerSub: input.ownerSub,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      format: isWork ? (input.format as WorkFormat) : null,
      status: isWork ? "draft" : null,
      sourceNote: isWork ? (input.sourceNote ?? null) : null,
    };

    try {
      const [created] = await this.db.insert(objects).values(row).returning();
      return toObject(created);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  async findById(id: string): Promise<BusinessObject | null> {
    const [row] = await this.db
      .select()
      .from(objects)
      .where(and(eq(objects.id, id), isNull(objects.deletedAt)))
      .limit(1);

    return row ? toObject(row) : null;
  }

  async list(query: ListObjectsQuery = {}): Promise<BusinessObject[]> {
    const conditions: SQL[] = [];

    if (!query.includeDeleted) {
      conditions.push(isNull(objects.deletedAt));
    }

    if (query.archivedOnly) {
      conditions.push(isNotNull(objects.archivedAt));
    } else if (!query.includeArchived) {
      conditions.push(isNull(objects.archivedAt));
    }

    if (query.type) {
      conditions.push(eq(objects.type, query.type));
    }

    if (query.ownerSub) {
      conditions.push(eq(objects.ownerSub, query.ownerSub));
    }

    if (query.library) {
      conditions.push(eq(objects.library, query.library));
    }

    if (query.status) {
      conditions.push(eq(objects.status, query.status));
    }

    if (query.search) {
      const pattern = likePattern(query.search);
      conditions.push(
        sql`(${objects.title} LIKE ${pattern} ESCAPE '\\' OR ${objects.description} LIKE ${pattern} ESCAPE '\\')`,
      );
    }

    if (query.category) {
      conditions.push(
        sql`exists (select 1 from json_each(${objects.categories}) where json_each.value = ${query.category})`,
      );
    }

    if (query.tag) {
      conditions.push(
        sql`exists (select 1 from json_each(${objects.tags}) where json_each.value = ${query.tag})`,
      );
    }

    const orderBy =
      query.sort === "created"
        ? [desc(objects.createdAt), asc(objects.id)]
        : query.sort === "title"
          ? [asc(objects.title), asc(objects.id)]
          : [desc(objects.updatedAt), asc(objects.id)];

    const rows = await this.db
      .select()
      .from(objects)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(...orderBy)
      .limit(query.limit ?? 100)
      .offset(query.offset ?? 0);

    return rows.map(toObject);
  }

  async update(id: string, input: UpdateObjectInput): Promise<BusinessObject> {
    const current = await this.findById(id);

    if (!current) {
      throw new NotFoundError("对象不存在或已删除", { id });
    }

    const categories =
      input.categories === undefined ? current.categories : [...input.categories];

    const patch: Partial<NewObjectRow> = {
      title: input.title ?? current.title,
      description:
        input.description === undefined ? current.description : input.description,
      source: (input.source ?? current.source) as NewObjectRow["source"],
      origin: (input.origin ?? current.origin) as NewObjectRow["origin"],
      categories,
      primaryCategory: categories[0] ?? null,
      tags: input.tags === undefined ? current.tags : [...input.tags],
      priority: (input.priority ?? current.priority) as NewObjectRow["priority"],
      updatedAt: input.now ?? nowIso(),
      revision: current.revision + 1,
    };

    if (current.type === "work") {
      if (input.format !== undefined) {
        if (!isWorkFormat(input.format)) {
          throw new ValidationError("非法的作品 format", { format: input.format });
        }
        patch.format = input.format;
      }

      patch.sourceNote = input.sourceNote === undefined ? current.sourceNote : input.sourceNote;
    } else if (input.format !== undefined || input.sourceNote !== undefined) {
      throw new ValidationError("资产不允许携带 format / sourceNote", { type: current.type });
    }

    try {
      // 元数据变更与 outbox 入队同事务：不能出现「已改库但没有同步任务」。
      const updated = this.db.transaction((tx) => {
        const row = tx
          .update(objects)
          .set(patch)
          .where(
            and(
              eq(objects.id, id),
              eq(objects.revision, input.expectedRevision),
              isNull(objects.deletedAt),
            ),
          )
          .returning()
          .get();

        if (!row) {
          throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
            id,
            expectedRevision: input.expectedRevision,
          });
        }

        enqueueSyncJob(
          tx,
          row.type as "asset" | "work",
          id,
          "upsert",
          patch.updatedAt as string,
        );

        return row;
      });

      return toObject(updated);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  async changeStatus(input: ChangeStatusInput): Promise<BusinessObject> {
    const now = input.now ?? nowIso();

    if (!isWorkStatus(input.to)) {
      throw new ValidationError("非法的作品状态", { status: input.to });
    }

    const current = await this.findById(input.objectId);

    if (!current) {
      throw new NotFoundError("对象不存在或已删除", { id: input.objectId });
    }

    if (current.type !== "work") {
      throw new ValidationError("资产没有作品状态", { id: input.objectId });
    }

    // 归档是「退出工作台」的明确意图，先取消归档再推进，避免归档内容被悄悄改动。
    if (current.archivedAt) {
      throw new ConflictError("已归档的作品不能推进状态，请先取消归档", {
        id: input.objectId,
        archivedAt: current.archivedAt,
      });
    }

    // 状态机在这里是唯一的写入口：非法迁移与「外库直接 practiced」都先于 SQL 被拒绝。
    assertTransition(current.status, input.to, { library: current.library });

    const expectedRevision = input.expectedRevision ?? current.revision;

    if (expectedRevision !== current.revision) {
      throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
        id: input.objectId,
        expectedRevision,
        actualRevision: current.revision,
      });
    }

    try {
      const [updated] = await this.db
        .update(objects)
        .set({
          status: input.to,
          updatedAt: now,
          revision: current.revision + 1,
        })
        .where(
          and(
            eq(objects.id, input.objectId),
            eq(objects.revision, expectedRevision),
            isNull(objects.deletedAt),
          ),
        )
        .returning();

      if (!updated) {
        throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
          id: input.objectId,
          expectedRevision,
        });
      }

      return toObject(updated);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  async softDelete(id: string, at: string = nowIso()): Promise<void> {
    const current = await this.findById(id);

    if (!current) {
      throw new NotFoundError("对象不存在或已删除", { id });
    }

    try {
      // 删除与「通知 RAGFlow 删除文档」同事务，避免留下孤儿文档。
      this.db.transaction((tx) => {
        const row = tx
          .update(objects)
          .set({ deletedAt: at, updatedAt: at })
          .where(and(eq(objects.id, id), isNull(objects.deletedAt)))
          .returning({ id: objects.id })
          .get();

        if (!row) {
          throw new NotFoundError("对象不存在或已删除", { id });
        }

        enqueueSyncJob(tx, current.type, id, "delete", at);
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      return translateSqliteError(error);
    }
  }

  async archive(id: string, at: string = nowIso()): Promise<BusinessObject> {
    const row = this.db.transaction((tx) => {
      const updated = tx
        .update(objects)
        .set({ archivedAt: at, updatedAt: at, revision: sql`${objects.revision} + 1` })
        .where(and(eq(objects.id, id), isNull(objects.archivedAt), isNull(objects.deletedAt)))
        .returning()
        .get();

      if (updated) {
        enqueueSyncJob(tx, updated.type as "asset" | "work", id, "upsert", at);
      }

      return updated ?? null;
    });

    if (row) {
      return toObject(row);
    }

    // 已归档则原样返回；不存在才报错。
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError("对象不存在或已删除", { id });
    }

    return existing;
  }

  async unarchive(id: string, at: string = nowIso()): Promise<BusinessObject> {
    const row = this.db.transaction((tx) => {
      const updated = tx
        .update(objects)
        .set({ archivedAt: null, updatedAt: at, revision: sql`${objects.revision} + 1` })
        .where(and(eq(objects.id, id), isNotNull(objects.archivedAt), isNull(objects.deletedAt)))
        .returning()
        .get();

      if (updated) {
        enqueueSyncJob(tx, updated.type as "asset" | "work", id, "upsert", at);
      }

      return updated ?? null;
    });

    if (row) {
      return toObject(row);
    }

    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError("对象不存在或已删除", { id });
    }

    return existing;
  }

  async changeLibrary(input: ChangeLibraryInput): Promise<BusinessObject> {
    const now = input.now ?? nowIso();

    if (!isLibrary(input.to)) {
      throw new ValidationError("非法的 library 取值", { to: input.to });
    }

    if (input.reason.trim() === "") {
      throw new ValidationError("跨库迁移必须填写理由");
    }

    const current = await this.findById(input.objectId);

    if (!current) {
      throw new NotFoundError("对象不存在或已删除", { id: input.objectId });
    }

    if (current.library === input.to) {
      throw new ValidationError("对象已处于目标库，无需迁移", {
        objectId: input.objectId,
        library: input.to,
      });
    }

    // 先于数据库 CHECK 给出可读错误：已 practiced 的作品不能迁回外库。
    if (current.type === "work" && input.to === "external" && current.status === "practiced") {
      throw new DomainError(
        "EXTERNAL_LIBRARY_PRACTICED",
        "已 practiced 的作品不能迁回外库",
        { id: input.objectId, status: current.status },
      );
    }

    const expectedRevision = input.expectedRevision ?? current.revision;

    if (expectedRevision !== current.revision) {
      throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
        id: input.objectId,
        expectedRevision,
        actualRevision: current.revision,
      });
    }

    try {
      // 更新对象与写审计必须同事务：不能出现「库别已变但没有记录」。
      // better-sqlite3 的事务是同步的，这里用 .get()/.run() 而不是 await。
      const updated = this.db.transaction((tx) => {
        const row = tx
          .update(objects)
          .set({
            library: input.to,
            libraryChangedAt: now,
            updatedAt: now,
            revision: current.revision + 1,
          })
          .where(and(eq(objects.id, input.objectId), eq(objects.revision, expectedRevision)))
          .returning()
          .get();

        if (!row) {
          throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
            id: input.objectId,
          });
        }

        tx.insert(libraryEvents)
          .values({
            id: ulid(),
            objectId: input.objectId,
            fromLibrary: current.library,
            toLibrary: input.to,
            reason: input.reason,
            actorSub: input.actorSub,
            createdAt: now,
          })
          .run();

        enqueueSyncJob(tx, row.type as "asset" | "work", input.objectId, "upsert", now);

        return toObject(row);
      });

      return updated;
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  async listLibraryEvents(objectId: string): Promise<LibraryChangeEvent[]> {
    const rows = await this.db
      .select()
      .from(libraryEvents)
      .where(eq(libraryEvents.objectId, objectId))
      .orderBy(asc(libraryEvents.createdAt));

    return rows.map(toLibraryEvent);
  }
}

