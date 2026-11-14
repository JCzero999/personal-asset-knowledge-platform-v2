import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import {
  isCategory,
  isLibrary,
  isValueLevel,
  isWorkStatus,
  type AiStatus,
  type AssetSourceType,
  type BusinessObject,
  type Category,
  type ValueLevel,
  type WorkStatus,
} from "../../domain/objects";
import type { AiScoreDetail, ValueScores } from "../../domain/value";
import { fallbackValueScores } from "../../domain/value";
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
  ApplyAiScoreInput,
  ApplyValueAssessmentInput,
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
  ReviewAssetInput,
  SettlePracticeInput,
  SettlePracticeResult,
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
    // 作品专属（资产恒为 null）
    publishedAt: row.publishedAt,
    practicedAt: row.practicedAt,
    practiceMetrics: parseJson<Record<string, unknown>>(row.practiceMetrics),
    settledAssetId: row.settledAssetId,
    // 资产专属（作品恒为 null）
    sourceType: row.sourceType as AssetSourceType | null,
    aiStatus: row.aiStatus as AiStatus | null,
    aiScore: row.aiScore,
    aiScoreDetail: parseJson<AiScoreDetail>(row.aiScoreDetail),
    valueLevel: row.valueLevel as ValueLevel | null,
    valueScores: parseJson<ValueScores>(row.valueScores),
    valueAssessedAt: row.valueAssessedAt,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    originWorkId: row.originWorkId,
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

/** 解析列里的 JSON 文本；脏值按 null 处理，不让一条坏行毁掉整个列表。 */
function parseJson<T>(value: string | null): T | null {
  if (!value) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
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

    // 作品只存在于外库（ADR-029）：先于数据库 CHECK 给出可读错误。
    if (isWork && input.library !== "external") {
      throw new DomainError("WORK_MUST_BE_EXTERNAL", "作品只能存在于外库", {
        library: input.library,
      });
    }

    if (!isWork && input.category != null && !isCategory(input.category)) {
      throw new ValidationError("非法的分类", { category: input.category });
    }

    if (!isWork && input.valueLevel != null && !isValueLevel(input.valueLevel)) {
      throw new ValidationError("非法的价值等级", { valueLevel: input.valueLevel });
    }

    const source = input.source ?? "handwritten";
    // 资产来源类型：显式优先，否则按 source 推断（与 0010 迁移的推断一致）。
    const sourceType: AssetSourceType | null = isWork
      ? null
      : (input.sourceType ?? (source === "ai_extracted" ? "ai_extract" : "external_direct"));

    // 规格 v2.0 规则 4：内库资产必须带 5 维分与等级。服务层会在自动入库 /
    // 复核 / 结算时写入；仓储层这里补齐缺失项（确定性兜底），保证任何
    // 合法的 create 路径都不会产出数据库 CHECK 拒绝的行。
    let valueLevel: ValueLevel | null = isWork ? null : (input.valueLevel ?? null);
    let valueScores: ValueScores | null = isWork ? null : (input.valueScores ?? null);
    let valueAssessedAt: string | null = isWork ? null : (input.valueAssessedAt ?? null);

    if (!isWork && input.library === "internal") {
      if (valueLevel == null || valueScores == null || valueAssessedAt == null) {
        const fallback = fallbackValueScores(valueAssessedAt ?? now);
        valueScores ??= fallback;
        valueLevel ??= valueScores.level;
        valueAssessedAt ??= fallback.assessedAt;
      }
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
      source,
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
      // 作品专属：publishedAt / practicedAt / metrics / settledAssetId 只能由专用流程写。
      publishedAt: null,
      practicedAt: null,
      practiceMetrics: null,
      settledAssetId: null,
      // 资产专属：作品一律为 NULL。
      sourceType,
      aiStatus: isWork ? null : (input.aiStatus ?? "unscored"),
      aiScore: null,
      aiScoreDetail: null,
      valueLevel,
      valueScores: jsonOrNull(valueScores),
      valueAssessedAt,
      useCount: 0,
      lastUsedAt: null,
      originWorkId: isWork ? null : (input.originWorkId ?? null),
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

  /**
   * 提炼幂等查重：同一草稿已产出过的 ai_extract 资产。
   * 只看未删除的行——用户删掉旧资产后允许重新提炼。
   */
  async findExtractedByOriginWork(originWorkId: string): Promise<BusinessObject | null> {
    const [row] = await this.db
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.originWorkId, originWorkId),
          eq(objects.sourceType, "ai_extract"),
          isNull(objects.deletedAt),
        ),
      )
      .orderBy(asc(objects.createdAt))
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

    if (query.aiStatus) {
      conditions.push(eq(objects.aiStatus, query.aiStatus));
    }

    if (query.valueLevel) {
      conditions.push(eq(objects.valueLevel, query.valueLevel));
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

    // 「已实践」不是纯状态位：它必须同时沉淀内库资产（规格 v2.0 第 7 节第 2 条）。
    if (input.to === "practiced") {
      throw new ConflictError("标记「已实践」必须走实践结算接口，以保证立即沉淀为内库资产", {
        id: input.objectId,
        to: input.to,
      });
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

    // 状态机在这里是唯一的写入口：非法迁移与库别限制都先于 SQL 被拒绝。
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
          // 发布时间只在第一次进入 published 时记录，回退后重发不覆盖原始时间。
          ...(input.to === "published" && !current.publishedAt ? { publishedAt: now } : {}),
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

    // 作品只存在于外库（ADR-029 取代 ADR-008 的「先迁内库才能 practiced」）。
    if (current.type === "work" && input.to === "internal") {
      throw new DomainError(
        "WORK_MUST_BE_EXTERNAL",
        "作品不能迁入内库：已实践时由实践结算生成内库资产",
        { id: input.objectId, status: current.status },
      );
    }

    // 规格 v2.0 规则 3：进入内库只有两条路——6 维高分自动通过、人工复核批准。
    // 手工改库别会绕过打分与 5 维评估，因此资产外→内一律拒绝；内→外仍允许留痕。
    if (current.type === "asset" && input.to === "internal") {
      throw new DomainError(
        "LIBRARY_ENTRY_DENIED",
        "外库资产只能通过 AI 高分或人工复核进入内库",
        { id: input.objectId, aiStatus: current.aiStatus },
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

  async applyAiScore(input: ApplyAiScoreInput): Promise<BusinessObject> {
    const now = input.now ?? nowIso();
    const current = await this.findById(input.objectId);

    if (!current) {
      throw new NotFoundError("对象不存在或已删除", { id: input.objectId });
    }

    if (current.type !== "asset") {
      throw new ValidationError("只有资产可以打 AI 分", { id: input.objectId, type: current.type });
    }

    if (current.library !== "external") {
      throw new ConflictError("只有外库资产需要打分，内库资产请直接重评价值", {
        id: input.objectId,
        library: current.library,
      });
    }

    const promote = input.detail.verdict === "auto_pass";

    if (promote && !input.assessment) {
      throw new ValidationError("自动进入内库必须同时写入 5 维价值评估", {
        id: input.objectId,
      });
    }

    const expectedRevision = input.expectedRevision ?? current.revision;

    if (expectedRevision !== current.revision) {
      throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
        id: input.objectId,
        expectedRevision,
        actualRevision: current.revision,
      });
    }

    const patch: Partial<NewObjectRow> = {
      aiStatus: input.detail.verdict,
      aiScore: input.detail.total,
      aiScoreDetail: JSON.stringify(input.detail),
      updatedAt: now,
      revision: current.revision + 1,
    };

    if (promote && input.assessment) {
      patch.library = "internal";
      patch.libraryChangedAt = now;
      patch.valueLevel = input.assessment.valueLevel;
      patch.valueScores = JSON.stringify(input.assessment.valueScores);
      patch.valueAssessedAt = input.assessment.valueAssessedAt;
    }

    try {
      // 打分、转库、价值评估、审计、入队必须同时成立：不允许出现
      // 「已在内库但没有等级」或「分数写了但库别没动」。
      const updated = this.db.transaction((tx) => {
        const row = tx
          .update(objects)
          .set(patch)
          .where(
            and(
              eq(objects.id, input.objectId),
              eq(objects.revision, expectedRevision),
              isNull(objects.deletedAt),
            ),
          )
          .returning()
          .get();

        if (!row) {
          throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
            id: input.objectId,
          });
        }

        if (promote) {
          tx.insert(libraryEvents)
            .values({
              id: ulid(),
              objectId: input.objectId,
              fromLibrary: "external",
              toLibrary: "internal",
              reason: `AI 打分 ${input.detail.total} 分，自动沉淀（≥75）`,
              actorSub: input.actor.sub,
              createdAt: now,
            })
            .run();
        }

        writeAudit(tx, {
          actor: input.actor,
          action: "object.ai.score",
          targetType: "asset",
          targetId: input.objectId,
          detail: {
            total: input.detail.total,
            verdict: input.detail.verdict,
            model: input.detail.model,
            promoted: promote,
            title: current.title,
          },
          createdAt: now,
        });

        enqueueSyncJob(tx, "asset", input.objectId, "upsert", now);

        return row;
      });

      return toObject(updated, loadTagLabels(this.db, [updated.id]).get(updated.id) ?? []);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      return translateSqliteError(error);
    }
  }

  async reviewAsset(input: ReviewAssetInput): Promise<BusinessObject> {
    const now = input.now ?? nowIso();
    const current = await this.findById(input.objectId);

    if (!current) {
      throw new NotFoundError("对象不存在或已删除", { id: input.objectId });
    }

    if (current.type !== "asset") {
      throw new ValidationError("只有资产可以人工复核", { id: input.objectId, type: current.type });
    }

    if (current.aiStatus !== "needs_review") {
      throw new ConflictError("只有待人工复核的资产可以复核", {
        id: input.objectId,
        aiStatus: current.aiStatus,
      });
    }

    const approve = input.decision === "approve";

    if (approve && !input.assessment) {
      throw new ValidationError("人工通过必须同时写入 5 维价值评估", { id: input.objectId });
    }

    const expectedRevision = input.expectedRevision ?? current.revision;

    if (expectedRevision !== current.revision) {
      throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
        id: input.objectId,
        expectedRevision,
        actualRevision: current.revision,
      });
    }

    const detail = mergeReviewDetail(current.aiScoreDetail, {
      decision: input.decision,
      note: input.note,
      at: now,
      actorSub: input.actor.sub,
    });

    const patch: Partial<NewObjectRow> = {
      // 人工拒绝回到「低价值外库」，与 AI 低分共用同一个处置桶。
      aiStatus: approve ? "approved" : "low_value",
      aiScoreDetail: JSON.stringify(detail),
      updatedAt: now,
      revision: current.revision + 1,
    };

    if (approve && input.assessment) {
      patch.library = "internal";
      patch.libraryChangedAt = now;
      patch.valueLevel = input.assessment.valueLevel;
      patch.valueScores = JSON.stringify(input.assessment.valueScores);
      patch.valueAssessedAt = input.assessment.valueAssessedAt;
    }

    try {
      const updated = this.db.transaction((tx) => {
        const row = tx
          .update(objects)
          .set(patch)
          .where(
            and(
              eq(objects.id, input.objectId),
              eq(objects.revision, expectedRevision),
              isNull(objects.deletedAt),
            ),
          )
          .returning()
          .get();

        if (!row) {
          throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
            id: input.objectId,
          });
        }

        if (approve) {
          tx.insert(libraryEvents)
            .values({
              id: ulid(),
              objectId: input.objectId,
              fromLibrary: "external",
              toLibrary: "internal",
              reason: `人工复核通过${input.note ? `：${input.note}` : ""}`,
              actorSub: input.actor.sub,
              createdAt: now,
            })
            .run();
        }

        writeAudit(tx, {
          actor: input.actor,
          action: "object.ai.review",
          targetType: "asset",
          targetId: input.objectId,
          detail: {
            decision: input.decision,
            note: input.note,
            title: current.title,
          },
          createdAt: now,
        });

        enqueueSyncJob(tx, "asset", input.objectId, "upsert", now);

        return row;
      });

      return toObject(updated, loadTagLabels(this.db, [updated.id]).get(updated.id) ?? []);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      return translateSqliteError(error);
    }
  }

  async applyValueAssessment(input: ApplyValueAssessmentInput): Promise<BusinessObject> {
    const now = input.now ?? nowIso();
    const current = await this.findById(input.objectId);

    if (!current) {
      throw new NotFoundError("对象不存在或已删除", { id: input.objectId });
    }

    if (current.type !== "asset") {
      throw new ValidationError("只有资产需要价值评估", { id: input.objectId, type: current.type });
    }

    if (current.library !== "internal") {
      throw new ConflictError("只有内库资产需要价值评估", {
        id: input.objectId,
        library: current.library,
      });
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
      const updated = this.db.transaction((tx) => {
        const row = tx
          .update(objects)
          .set({
            valueLevel: input.assessment.valueLevel,
            valueScores: JSON.stringify(input.assessment.valueScores),
            valueAssessedAt: input.assessment.valueAssessedAt,
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
          .returning()
          .get();

        if (!row) {
          throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
            id: input.objectId,
          });
        }

        writeAudit(tx, {
          actor: input.actor,
          action: "object.value.assess",
          targetType: "asset",
          targetId: input.objectId,
          detail: {
            level: input.assessment.valueLevel,
            source: input.assessment.valueScores.source,
            title: current.title,
          },
          createdAt: now,
        });

        enqueueSyncJob(tx, "asset", input.objectId, "upsert", now);

        return row;
      });

      return toObject(updated, loadTagLabels(this.db, [updated.id]).get(updated.id) ?? []);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      return translateSqliteError(error);
    }
  }

  async settlePractice(input: SettlePracticeInput): Promise<SettlePracticeResult> {
    const now = input.now ?? nowIso();
    const current = await this.findById(input.workId);

    if (!current) {
      throw new NotFoundError("对象不存在或已删除", { id: input.workId });
    }

    if (current.type !== "work") {
      throw new ValidationError("只有作品可以标记已实践", { id: input.workId, type: current.type });
    }

    if (current.library !== "external") {
      throw new DomainError("WORK_MUST_BE_EXTERNAL", "作品只能在外库标记已实践", {
        id: input.workId,
        library: current.library,
      });
    }

    if (current.status !== "published") {
      throw new ConflictError("只有已发布的作品可以标记已实践", {
        id: input.workId,
        status: current.status,
      });
    }

    if (current.settledAssetId) {
      throw new ConflictError("该作品已经结算过，不能重复沉淀", {
        id: input.workId,
        settledAssetId: current.settledAssetId,
      });
    }

    const expectedRevision = input.expectedRevision ?? current.revision;

    if (expectedRevision !== current.revision) {
      throw new ConflictError("对象已被其他写入修改，请重新读取后再提交", {
        id: input.workId,
        expectedRevision,
        actualRevision: current.revision,
      });
    }

    const assetId = input.asset.id ?? ulid();
    const assetRow: NewObjectRow = {
      id: assetId,
      type: "asset",
      title: input.asset.title,
      description: input.asset.description,
      titleNorm: normalizeSearchText(input.asset.title),
      descriptionNorm: input.asset.description
        ? normalizeSearchText(input.asset.description)
        : null,
      library: "internal",
      source: input.asset.source,
      origin: input.asset.origin,
      categoryCode: input.asset.category,
      priority: input.asset.priority,
      archivedAt: null,
      libraryChangedAt: now,
      ownerSub: current.ownerSub,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      status: null,
      sourceNote: null,
      publishedAt: null,
      practicedAt: null,
      practiceMetrics: null,
      settledAssetId: null,
      sourceType: "practiced_work",
      // 由用户手动确认「已实践」而进入内库，视同已批准。
      aiStatus: "approved",
      aiScore: null,
      aiScoreDetail: null,
      valueLevel: input.assessment.valueLevel,
      valueScores: JSON.stringify(input.assessment.valueScores),
      valueAssessedAt: input.assessment.valueAssessedAt,
      useCount: 0,
      lastUsedAt: null,
      originWorkId: current.id,
    };

    try {
      // 资产、标签、作品状态、审计、入队全在一个事务里：
      // 任何一步失败都整体回滚，绝不留下「作品已实践但没有资产」的中间态。
      const settled = this.db.transaction((tx) => {
        const asset = tx.insert(objects).values(assetRow).returning().get();
        replaceObjectTags(tx, asset.id, input.asset.tags);

        const work = tx
          .update(objects)
          .set({
            status: "practiced",
            practicedAt: now,
            practiceMetrics: jsonOrNull(input.metrics),
            settledAssetId: asset.id,
            // 不归档：practiced 是作品的正常终态，作品要继续能在默认列表、
            // 词法检索、图谱与预览里查到；归档只由用户显式操作触发。
            updatedAt: now,
            revision: current.revision + 1,
          })
          .where(
            and(
              eq(objects.id, current.id),
              eq(objects.revision, expectedRevision),
              eq(objects.status, "published"),
              eq(objects.library, "external"),
              isNull(objects.deletedAt),
            ),
          )
          .returning()
          .get();

        if (!work) {
          throw new ConflictError("作品状态已变化，请重新读取后再标记已实践", {
            id: current.id,
          });
        }

        writeAudit(tx, {
          actor: input.actor,
          action: "object.practice",
          targetType: "work",
          targetId: current.id,
          detail: {
            title: current.title,
            assetId: asset.id,
            level: input.assessment.valueLevel,
            metrics: input.metrics,
          },
          createdAt: now,
        });

        enqueueSyncJob(tx, "asset", asset.id, "upsert", now);
        enqueueSyncJob(tx, "work", current.id, "upsert", now);

        return { work, asset };
      });

      const tagGroups = loadTagLabels(this.db, [settled.work.id, settled.asset.id]);

      return {
        work: toObject(settled.work, tagGroups.get(settled.work.id) ?? []),
        asset: toObject(settled.asset, tagGroups.get(settled.asset.id) ?? []),
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      return translateSqliteError(error);
    }
  }
}

/**
 * 把人工复核痕迹并进已有的打分明细；旧数据没有明细时补一个最小骨架，
 * 保证前端读到 `aiScoreDetail.review` 时结构稳定。
 */
function mergeReviewDetail(
  detail: AiScoreDetail | null,
  review: NonNullable<AiScoreDetail["review"]>,
): AiScoreDetail {
  const base: AiScoreDetail = detail ?? {
    dimensions: [],
    total: 0,
    verdict: "needs_review",
    model: "",
    scoredAt: review.at,
    source: "model",
  };

  return { ...base, review };
}

