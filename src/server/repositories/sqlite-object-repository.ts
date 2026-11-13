import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import {
  isCategory,
  isLibrary,
  isWorkStatus,
  type BusinessObject,
  type Category,
  type WorkStatus,
} from "../../domain/objects";
import { normalizeCategory, normalizeTag } from "../../domain/vocabulary";
import { ConflictError, DomainError, NotFoundError, ValidationError } from "../../domain/errors";
import { assertTransition } from "../../domain/workflow";
import type { ActorContext } from "../authz";
import { writeAudit } from "../services/audit-service";
import type { AppDatabase } from "../db/client";
import { ulid } from "../db/id";
import { translateSqliteError } from "./sqlite-errors";
import { replaceObjectTags } from "./tag-links";
import {
  categories,
  libraryEvents,
  objectTags,
  objects,
  syncJobs,
  tags,
  type LibraryEventRow,
  type NewObjectRow,
  type ObjectRow,
} from "../db/schema";
import type {
  ChangeLibraryInput,
  ChangeStatusInput,
  CreateObjectInput,
  LexicalCandidate,
  LexicalSearchInput,
  LexicalSearchResult,
  LexicalTermFilter,
  LibraryChangeEvent,
  ListObjectsQuery,
  ObjectRepository,
  UpdateObjectInput,
} from "../ports/object-repository";
import { normalizeSearchText } from "../../lib/search-query";

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

/**
 * 一个检索词的 SQL 条件（ADR-024 第 1、3 条）。
 *
 * 全部是参数化 `instr()` 子串匹配：中文没有空格分词，2 字词用 FTS5
 * 反而失效；`instr` 也不需要转义 `%` / `_`。分类 / 标签读 `normalized`
 * 列，改名后立即生效，没有第二套索引要同步。
 */
function lexicalTermCondition(term: LexicalTermFilter): SQL {
  const fields = term.field ? [term.field] : (["title", "description", "category", "tag"] as const);
  const parts: SQL[] = [];

  for (const field of fields) {
    switch (field) {
      case "title":
        parts.push(sql`instr(coalesce(${objects.titleNorm}, ''), ${term.value}) > 0`);
        break;
      case "description":
        parts.push(sql`instr(coalesce(${objects.descriptionNorm}, ''), ${term.value}) > 0`);
        break;
      case "category":
        parts.push(sql`instr(coalesce(${categories.normalized}, ''), ${term.value}) > 0`);
        break;
      case "tag":
        parts.push(sql`exists (
          select 1 from ${objectTags}
          inner join ${tags} on ${tags.id} = ${objectTags.tagId}
          where ${objectTags.objectId} = ${objects.id}
            and instr(${tags.normalized}, ${term.value}) > 0
        )`);
        break;
    }
  }

  const any = sql.join(parts, sql` or `);

  return term.negated ? sql`not (${any})` : sql`(${any})`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** LIKE 通配符按字面量匹配，避免用户输入的 % / _ 扩大搜索范围。 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * 标签水合：对外仍是 `tags: string[]`（ADR-016 第 4 条），真相源改成
 * `object_tags` 多对多。一次查询取回这批对象的全部标签，再在内存里分组。
 */
function loadTagLabels(db: AppDatabase, objectIds: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  if (objectIds.length === 0) return grouped;

  const rows = db
    .select({ objectId: objectTags.objectId, label: tags.label })
    .from(objectTags)
    .innerJoin(tags, eq(tags.id, objectTags.tagId))
    .where(inArray(objectTags.objectId, objectIds))
    .orderBy(asc(tags.sortOrder), asc(tags.label))
    .all();

  for (const row of rows) {
    const list = grouped.get(row.objectId) ?? [];
    list.push(row.label);
    grouped.set(row.objectId, list);
  }

  return grouped;
}

function toObject(row: ObjectRow, tagLabels: string[]): BusinessObject {
  const base = {
    id: row.id,
    title: row.title,
    description: row.description,
    library: row.library as BusinessObject["library"],
    source: row.source as BusinessObject["source"],
    origin: row.origin as BusinessObject["origin"],
    category: row.categoryCode,
    tags: tagLabels,
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
      category: row.categoryCode as Category,
      status: row.status as WorkStatus,
      sourceNote: row.sourceNote,
    };
  }

  return {
    ...base,
    type: "asset",
    category: row.categoryCode,
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
    const isWork = input.type === "work";

    if (!isWork && input.sourceNote != null) {
      throw new ValidationError("资产不允许携带 sourceNote", {
        type: input.type,
      });
    }

    if (isWork && !isCategory(input.category)) {
      throw new ValidationError("作品必须提供合法的 category", { category: input.category });
    }

    if (!isWork && input.category != null && !isCategory(input.category)) {
      throw new ValidationError("非法的分类", { category: input.category });
    }

    const row: NewObjectRow = {
      id: input.id ?? ulid(),
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      // 影子列与主列同一函数生成（ADR-024 风险 S1）。
      titleNorm: normalizeSearchText(input.title),
      descriptionNorm: input.description ? normalizeSearchText(input.description) : null,
      library: input.library,
      source: input.source ?? "handwritten",
      origin: input.origin ?? "self",
      categoryCode: input.category ?? null,
      priority: input.priority ?? "medium",
      archivedAt: null,
      libraryChangedAt: null,
      ownerSub: input.ownerSub,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      status: isWork ? "draft" : null,
      sourceNote: isWork ? (input.sourceNote ?? null) : null,
    };

    try {
      // 对象与标签链接同事务：不能出现「对象写进去了、标签没写」。
      const created = this.db.transaction((tx) => {
        const inserted = tx.insert(objects).values(row).returning().get();
        replaceObjectTags(tx, inserted.id, input.tags ?? []);
        return inserted;
      });

      return toObject(created, loadTagLabels(this.db, [created.id]).get(created.id) ?? []);
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

    if (!row) return null;

    return toObject(row, loadTagLabels(this.db, [row.id]).get(row.id) ?? []);
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
      // ADR-023：按 code 匹配；旧书签里是中文名称时按 normalized 解析。
      const normalized = normalizeCategory(query.category);
      conditions.push(
        sql`${objects.categoryCode} in (select ${categories.code} from ${categories}
             where ${categories.code} = ${query.category}
                or ${categories.normalized} = ${normalized})`,
      );
    }

    if (query.tag) {
      // 标签已词表化：按归一化键解析到 tag_id 再 join，不再扫 objects.tags 的 JSON。
      const normalized = normalizeTag(query.tag);
      conditions.push(
        sql`exists (select 1 from ${objectTags}
                   join ${tags} on ${tags.id} = ${objectTags.tagId}
                   where ${objectTags.objectId} = ${objects.id}
                     and ${tags.normalized} = ${normalized})`,
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

    const tagGroups = loadTagLabels(
      this.db,
      rows.map((row) => row.id),
    );

    return rows.map((row) => toObject(row, tagGroups.get(row.id) ?? []));
  }

  async lexicalSearch(input: LexicalSearchInput): Promise<LexicalSearchResult> {
    const limit = Math.max(1, Math.min(input.limit ?? 500, 500));

    const conditions: SQL[] = [
      eq(objects.ownerSub, input.ownerSub),
      isNull(objects.deletedAt),
      isNull(objects.archivedAt),
    ];

    if (input.library) {
      conditions.push(eq(objects.library, input.library));
    }

    for (const term of input.terms) {
      conditions.push(lexicalTermCondition(term));
    }

    // 多取一条判断是否被截断（ADR-024 第 9 条）。
    const rows = this.db
      .select({ object: objects, categoryLabel: categories.label })
      .from(objects)
      .leftJoin(categories, eq(categories.code, objects.categoryCode))
      .where(and(...conditions))
      .orderBy(desc(objects.updatedAt), asc(objects.id))
      .limit(limit + 1)
      .all();

    const truncated = rows.length > limit;
    const visible = truncated ? rows.slice(0, limit) : rows;
    const tagGroups = loadTagLabels(
      this.db,
      visible.map((row) => row.object.id),
    );

    const candidates: LexicalCandidate[] = visible.map((row) => ({
      object: toObject(row.object, tagGroups.get(row.object.id) ?? []),
      categoryLabel: row.categoryLabel,
    }));

    return { candidates, truncated };
  }

  async update(id: string, input: UpdateObjectInput): Promise<BusinessObject> {
    const current = await this.findById(id);

    if (!current) {
      throw new NotFoundError("对象不存在或已删除", { id });
    }

    const nextTitle = input.title ?? current.title;
    const nextDescription =
      input.description === undefined ? current.description : input.description;

    const patch: Partial<NewObjectRow> = {
      title: nextTitle,
      description: nextDescription,
      titleNorm: normalizeSearchText(nextTitle),
      descriptionNorm: nextDescription ? normalizeSearchText(nextDescription) : null,
      source: (input.source ?? current.source) as NewObjectRow["source"],
      origin: (input.origin ?? current.origin) as NewObjectRow["origin"],
      priority: (input.priority ?? current.priority) as NewObjectRow["priority"],
      updatedAt: input.now ?? nowIso(),
      revision: current.revision + 1,
    };

    if (input.category !== undefined) {
      if (input.category === null) {
        if (current.type === "work") {
          throw new ValidationError("作品必须有分类", { category: null });
        }
        patch.categoryCode = null;
      } else {
        if (!isCategory(input.category)) {
          throw new ValidationError("非法的分类", { category: input.category });
        }
        patch.categoryCode = input.category;
      }
    }

    if (current.type === "work") {
      patch.sourceNote = input.sourceNote === undefined ? current.sourceNote : input.sourceNote;
    } else if (input.sourceNote !== undefined) {
      throw new ValidationError("资产不允许携带 sourceNote", { type: current.type });
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

        // 标签是独立的多对多表：整组替换，与对象写入同事务。
        if (input.tags !== undefined) {
          replaceObjectTags(tx, id, input.tags);
        }

        return row;
      });

      return toObject(updated, loadTagLabels(this.db, [updated.id]).get(updated.id) ?? []);
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

      return toObject(updated, loadTagLabels(this.db, [updated.id]).get(updated.id) ?? []);
    } catch (error) {
      return translateSqliteError(error);
    }
  }

  async softDelete(
    id: string,
    at: string = nowIso(),
    actor?: ActorContext,
  ): Promise<void> {
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

        // 审计与业务写同事务：删了对象却没有删除记录是不可接受的。
        if (actor) {
          writeAudit(tx, {
            actor,
            action: "object.delete",
            targetType: "object",
            targetId: id,
            detail: { type: current.type, title: current.title },
            createdAt: at,
          });
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

  async archive(
    id: string,
    at: string = nowIso(),
    actor?: ActorContext,
  ): Promise<BusinessObject> {
    const row = this.db.transaction((tx) => {
      const updated = tx
        .update(objects)
        .set({ archivedAt: at, updatedAt: at, revision: sql`${objects.revision} + 1` })
        .where(and(eq(objects.id, id), isNull(objects.archivedAt), isNull(objects.deletedAt)))
        .returning()
        .get();

      if (updated) {
        if (actor) {
          writeAudit(tx, {
            actor,
            action: "object.archive",
            targetType: "object",
            targetId: id,
            detail: { title: updated.title },
            createdAt: at,
          });
        }
        enqueueSyncJob(tx, updated.type as "asset" | "work", id, "upsert", at);
      }

      return updated ?? null;
    });

    if (row) {
      return toObject(row, loadTagLabels(this.db, [row.id]).get(row.id) ?? []);
    }

    // 已归档则原样返回；不存在才报错。
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundError("对象不存在或已删除", { id });
    }

    return existing;
  }

  async unarchive(
    id: string,
    at: string = nowIso(),
    actor?: ActorContext,
  ): Promise<BusinessObject> {
    const row = this.db.transaction((tx) => {
      const updated = tx
        .update(objects)
        .set({ archivedAt: null, updatedAt: at, revision: sql`${objects.revision} + 1` })
        .where(and(eq(objects.id, id), isNotNull(objects.archivedAt), isNull(objects.deletedAt)))
        .returning()
        .get();

      if (updated) {
        if (actor) {
          writeAudit(tx, {
            actor,
            action: "object.unarchive",
            targetType: "object",
            targetId: id,
            detail: { title: updated.title },
            createdAt: at,
          });
        }
        enqueueSyncJob(tx, updated.type as "asset" | "work", id, "upsert", at);
      }

      return updated ?? null;
    });

    if (row) {
      return toObject(row, loadTagLabels(this.db, [row.id]).get(row.id) ?? []);
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

        // library_events 是领域记录，audit_events 是操作断言，两条一起写（ADR-019）。
        writeAudit(tx, {
          actor: { sub: input.actorSub, userId: input.actorUserId ?? null },
          action: "object.library.change",
          targetType: "object",
          targetId: input.objectId,
          detail: {
            from: current.library,
            to: input.to,
            reason: input.reason,
            title: current.title,
          },
          createdAt: now,
        });

        enqueueSyncJob(tx, row.type as "asset" | "work", input.objectId, "upsert", now);

        return row;
      });

      return toObject(updated, loadTagLabels(this.db, [updated.id]).get(updated.id) ?? []);
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

