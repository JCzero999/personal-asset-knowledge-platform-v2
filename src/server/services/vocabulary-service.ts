import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { ConflictError, DomainError, NotFoundError, ValidationError } from "../../domain/errors";
import {
  CATEGORY_CODE_PATTERN,
  MAX_ACTIVE_CATEGORIES,
  MAX_CATEGORY_CODE,
  MAX_CATEGORY_LABEL,
  MAX_TAG_LENGTH,
  TAG_SOFT_LIMIT,
  categoryLabelProblem,
  deriveCategoryCode,
  displayLabel,
  displayTagLabel,
  isCategoryState,
  normalizeCategory,
  normalizeTag,
  tagLabelProblem,
  type CategoryState,
  type VocabularyCategory,
  type VocabularySnapshot,
  type VocabularyTag,
} from "../../domain/vocabulary";
import type { ActorContext } from "../authz";
import type { AppDatabase } from "../db/client";
import { ulid } from "../db/id";
import { writeAudit } from "./audit-service";
import { categories, objectTags, objects, syncJobs, tags } from "../db/schema";

/** better-sqlite3 事务里的 drizzle 句柄，仅供同步写入使用。 */
type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function readLabel(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} 必须是字符串`, { field });
  }

  const label = displayLabel(value);
  const problem = field === "label" ? categoryLabelProblem(label) : tagLabelProblem(label);

  if (problem) {
    throw new ValidationError(problem, { field, max });
  }

  return label;
}

/**
 * 词表读取的唯一入口（ADR-016 第 5 条，ADR-023 第 3 条）。
 *
 * 使用次数必须排除软删对象：对象是软删除，外键级联不会触发，直接 count
 * 引用会让「看不见的引用」挡住删除（风险 R3）。分类统计**包含资产**。
 */
export function listVocabulary(db: AppDatabase): VocabularySnapshot {
  return { categories: listCategories(db), tags: listTags(db) };
}

export function listCategories(db: AppDatabase): VocabularyCategory[] {
  const usage = new Map<string, number>();

  const usageRows = db
    .select({ code: objects.categoryCode, usage: sql<number>`count(*)` })
    .from(objects)
    .where(and(isNull(objects.deletedAt), isNotNull(objects.categoryCode)))
    .groupBy(objects.categoryCode)
    .all();

  for (const row of usageRows) {
    if (row.code) usage.set(row.code, Number(row.usage));
  }

  return db
    .select()
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.code))
    .all()
    .map((row) => ({
      code: row.code,
      label: row.label,
      normalized: row.normalized,
      sortOrder: row.sortOrder,
      state: row.state as CategoryState,
      isSystem: Boolean(row.isSystem),
      usage: usage.get(row.code) ?? 0,
    }));
}

function listTags(db: AppDatabase): VocabularyTag[] {
  const usage = new Map<string, number>();

  const usageRows = db
    .select({ id: tags.id, usage: sql<number>`count(${objects.id})` })
    .from(tags)
    .leftJoin(objectTags, eq(objectTags.tagId, tags.id))
    .leftJoin(objects, and(eq(objects.id, objectTags.objectId), isNull(objects.deletedAt)))
    .groupBy(tags.id)
    .all();

  for (const row of usageRows) {
    usage.set(row.id, Number(row.usage));
  }

  return db
    .select()
    .from(tags)
    .orderBy(asc(tags.sortOrder), asc(tags.label))
    .all()
    .map((row) => ({
      id: row.id,
      label: row.label,
      normalized: row.normalized,
      sortOrder: row.sortOrder,
      usage: usage.get(row.id) ?? 0,
    }));
}

/** 新建 / 编辑面板只该看到启用分类；服务端校验也按这个口径。 */
export function listActiveCategoryCodes(db: AppDatabase): string[] {
  return db
    .select({ code: categories.code })
    .from(categories)
    .where(eq(categories.state, "active"))
    .orderBy(asc(categories.sortOrder))
    .all()
    .map((row) => row.code);
}

export function categoryUsage(db: AppDatabase, code: string): number {
  const row = db
    .select({ usage: sql<number>`count(*)` })
    .from(objects)
    .where(and(eq(objects.categoryCode, code), isNull(objects.deletedAt)))
    .get();

  return Number(row?.usage ?? 0);
}

function requireCategory(db: AppDatabase, code: string) {
  const row = db.select().from(categories).where(eq(categories.code, code)).get();

  if (!row) {
    throw new NotFoundError("分类不存在", { code });
  }

  return row;
}

function findCategoryByNormalized(db: AppDatabase, normalized: string) {
  return db.select().from(categories).where(eq(categories.normalized, normalized)).get();
}

function activeCategoryCount(db: AppDatabase, exclude?: string): number {
  const rows = db
    .select({ code: categories.code })
    .from(categories)
    .where(eq(categories.state, "active"))
    .all();

  return rows.filter((row) => row.code !== exclude).length;
}

function sampleObjects(db: AppDatabase, code: string) {
  return db
    .select({ id: objects.id, title: objects.title })
    .from(objects)
    .where(and(eq(objects.categoryCode, code), isNull(objects.deletedAt)))
    .limit(5)
    .all();
}

function toCategory(row: typeof categories.$inferSelect, usage: number): VocabularyCategory {
  return {
    code: row.code,
    label: row.label,
    normalized: row.normalized,
    sortOrder: row.sortOrder,
    state: row.state as CategoryState,
    isSystem: Boolean(row.isSystem),
    usage,
  };
}

/** 内联创建（ADR-023 第 8 条）会在审计 detail 里带 `source: "inline"`。 */
function readSource(record: Record<string, unknown>): "inline" | "admin" {
  return record.source === "inline" ? "inline" : "admin";
}

export interface CreateCategoryInput {
  label: string;
  code?: string;
  sortOrder?: number;
}

export interface CreateCategoryResult {
  category: VocabularyCategory;
  /** false 表示 `reuseExisting` 命中已有词条，路由回 200 而不是 201。 */
  created: boolean;
}

/**
 * 新建分类。三种重名情形分开处理（ADR-023 第 8 条）：
 * - `reuseExisting: true` 且命中启用项 → 复用（内联创建用，避免重复点按报错）；
 * - 命中停用项 → `CATEGORY_ARCHIVED`，不自动复活（普通编辑者不能绕过管理动作）；
 * - 其余命中 → `CATEGORY_EXISTS`。
 */
export function createCategory(
  db: AppDatabase,
  actor: ActorContext,
  body: unknown,
): CreateCategoryResult {
  const record = asRecord(body);
  const label = readLabel(record.label, "label", MAX_CATEGORY_LABEL);
  const normalized = normalizeCategory(label);
  const existing = findCategoryByNormalized(db, normalized);

  if (existing) {
    if (existing.state === "archived") {
      throw new DomainError(
        "CATEGORY_ARCHIVED",
        `分类「${label}」已停用，请联系管理员启用`,
        { label, code: existing.code },
      );
    }

    if (record.reuseExisting === true) {
      return {
        category: toCategory(existing, categoryUsage(db, existing.code)),
        created: false,
      };
    }

    throw new DomainError("CATEGORY_EXISTS", `分类「${label}」已存在`, {
      label,
      normalized,
      code: existing.code,
    });
  }

  if (activeCategoryCount(db) >= MAX_ACTIVE_CATEGORIES) {
    throw new ValidationError(`启用分类最多 ${MAX_ACTIVE_CATEGORIES} 个`, {
      max: MAX_ACTIVE_CATEGORIES,
    });
  }

  let code = "";

  if (record.code !== undefined && record.code !== null) {
    if (typeof record.code !== "string" || !CATEGORY_CODE_PATTERN.test(record.code)) {
      throw new ValidationError(
        "标识只能是 2–32 位小写字母、数字、连字符或下划线",
        { field: "code", max: MAX_CATEGORY_CODE },
      );
    }
    code = record.code;
  } else {
    const base = deriveCategoryCode(label, `c-${ulid().slice(-8).toLowerCase()}`);
    code = base;
    let suffix = 1;

    while (db.select({ code: categories.code }).from(categories).where(eq(categories.code, code)).get()) {
      suffix += 1;
      code = `${base.slice(0, MAX_CATEGORY_CODE - 3)}-${suffix}`;
    }
  }

  if (db.select({ code: categories.code }).from(categories).where(eq(categories.code, code)).get()) {
    throw new DomainError("CATEGORY_EXISTS", "分类标识已存在", { code });
  }

  const sortOrder =
    typeof record.sortOrder === "number"
      ? record.sortOrder
      : (db
          .select({ max: sql<number>`coalesce(max(${categories.sortOrder}), 0)` })
          .from(categories)
          .get()?.max ?? 0) + 10;

  const now = nowIso();
  const source = readSource(record);

  db.transaction((tx) => {
    tx.insert(categories)
      .values({
        code,
        label,
        normalized,
        sortOrder: Number(sortOrder),
        state: "active",
        isSystem: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    writeAudit(tx, {
      actor,
      action: "vocabulary.category.create",
      targetType: "category",
      targetId: code,
      detail: { label, normalized, sortOrder: Number(sortOrder), source },
      createdAt: now,
    });
  });

  return {
    category: {
      code,
      label,
      normalized,
      sortOrder: Number(sortOrder),
      state: "active",
      isSystem: false,
      usage: 0,
    },
    created: true,
  };
}

export interface UpdateCategoryInput {
  label?: string;
  sortOrder?: number;
  state?: CategoryState;
  /** 乐观校验：与库中 updatedAt 不一致时提示「已被修改」。 */
  expectedUpdatedAt?: string;
}

export function updateCategory(
  db: AppDatabase,
  actor: ActorContext,
  code: string,
  body: unknown,
): VocabularyCategory {
  const record = asRecord(body);
  const current = requireCategory(db, code);

  if (record.expectedUpdatedAt !== undefined && record.expectedUpdatedAt !== current.updatedAt) {
    throw new ConflictError("分类已被修改，请刷新后重试", {
      code,
      expectedUpdatedAt: record.expectedUpdatedAt,
      actualUpdatedAt: current.updatedAt,
    });
  }

  const patch: {
    label?: string;
    normalized?: string;
    sortOrder?: number;
    state?: CategoryState;
    updatedAt: string;
  } = { updatedAt: nowIso() };

  if (record.label !== undefined) {
    const label = readLabel(record.label, "label", MAX_CATEGORY_LABEL);
    const normalized = normalizeCategory(label);
    const clash = findCategoryByNormalized(db, normalized);

    if (clash && clash.code !== code) {
      throw new DomainError("CATEGORY_EXISTS", `分类「${label}」已存在`, {
        code: clash.code,
        label: clash.label,
      });
    }

    patch.label = label;
    patch.normalized = normalized;
  }

  if (record.sortOrder !== undefined) {
    if (typeof record.sortOrder !== "number" || !Number.isInteger(record.sortOrder)) {
      throw new ValidationError("sortOrder 必须是整数", { field: "sortOrder" });
    }
    patch.sortOrder = record.sortOrder;
  }

  if (record.state !== undefined) {
    if (!isCategoryState(record.state)) {
      throw new ValidationError("state 只能是 active 或 archived", { field: "state" });
    }

    if (record.state === "archived") {
      if (code === "uncategorized") {
        throw new ConflictError("「未分类」是兜底分类，不能停用", { code });
      }

      if (activeCategoryCount(db, code) === 0) {
        throw new ConflictError("至少保留一个启用分类", { code });
      }
    }

    patch.state = record.state;
  }

  db.transaction((tx) => {
    tx.update(categories).set(patch).where(eq(categories.code, code)).run();

    writeAudit(tx, {
      actor,
      action: "vocabulary.category.update",
      targetType: "category",
      targetId: code,
      detail: {
        label: patch.label,
        sortOrder: patch.sortOrder,
        state: patch.state,
      },
      createdAt: patch.updatedAt,
    });
  });

  return {
    code,
    label: patch.label ?? current.label,
    normalized: patch.normalized ?? current.normalized,
    sortOrder: patch.sortOrder ?? current.sortOrder,
    state: (patch.state ?? current.state) as CategoryState,
    isSystem: Boolean(current.isSystem),
    usage: categoryUsage(db, code),
  };
}

export interface DeleteCategoryOptions {
  /** 有引用时必须显式给目标分类，事务内批量改写后再删。 */
  migrateTo?: string;
}

export interface DeleteCategoryResult {
  deleted: string;
  migrated: number;
  migrateTo?: string;
}

function enqueueObjectSync(tx: Tx, objectId: string, now: string): void {
  tx.insert(syncJobs)
    .values({
      id: ulid(),
      ownerType: "work",
      ownerId: objectId,
      contentRefId: null,
      action: "upsert",
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

export function deleteCategory(
  db: AppDatabase,
  actor: ActorContext,
  code: string,
  options: DeleteCategoryOptions = {},
): DeleteCategoryResult {
  const current = requireCategory(db, code);

  if (current.isSystem) {
    throw new ConflictError("内置分类不能删除，只能改名或停用", {
      code,
      isSystem: true,
    });
  }

  const usage = categoryUsage(db, code);

  if (usage > 0 && !options.migrateTo) {
    throw new ConflictError(`该分类下还有 ${usage} 个对象，请先迁移或停用`, {
      code,
      usage,
      sample: sampleObjects(db, code),
    });
  }

  if (options.migrateTo) {
    if (options.migrateTo === code) {
      throw new ValidationError("迁移目标不能是自己", { code });
    }

    const target = requireCategory(db, options.migrateTo);

    if (target.state !== "active") {
      throw new DomainError("CATEGORY_ARCHIVED", "迁移目标分类已停用", {
        code: options.migrateTo,
      });
    }
  }

  if (activeCategoryCount(db, code) === 0) {
    throw new ConflictError("至少保留一个启用分类", { code });
  }

  const affected = db
    .select({ id: objects.id, type: objects.type, revision: objects.revision })
    .from(objects)
    .where(and(eq(objects.categoryCode, code), isNull(objects.deletedAt)))
    .all();

  const now = nowIso();

  db.transaction((tx) => {
    for (const row of affected) {
      tx.update(objects)
        .set({
          categoryCode: options.migrateTo as string,
          updatedAt: now,
          revision: row.revision + 1,
        })
        .where(eq(objects.id, row.id))
        .run();

      // 资产不进 RAGFlow，只有作品需要重新同步。
      if (row.type === "work") {
        enqueueObjectSync(tx, row.id, now);
      }
    }

    tx.delete(categories).where(eq(categories.code, code)).run();

    writeAudit(tx, {
      actor,
      action: "vocabulary.category.delete",
      targetType: "category",
      targetId: code,
      detail: {
        label: current.label,
        migrated: options.migrateTo ? affected.length : 0,
        migrateTo: options.migrateTo ?? null,
      },
      createdAt: now,
    });
  });

  return {
    deleted: code,
    migrated: options.migrateTo ? affected.length : 0,
    ...(options.migrateTo ? { migrateTo: options.migrateTo } : {}),
  };
}

function findTagByNormalized(db: AppDatabase, normalized: string) {
  return db.select().from(tags).where(eq(tags.normalized, normalized)).get();
}

function tagUsage(db: AppDatabase, tagId: string): number {
  const row = db
    .select({ usage: sql<number>`count(${objects.id})` })
    .from(objectTags)
    .innerJoin(objects, eq(objects.id, objectTags.objectId))
    .where(and(eq(objectTags.tagId, tagId), isNull(objects.deletedAt)))
    .get();

  return Number(row?.usage ?? 0);
}

export function createTag(
  db: AppDatabase,
  actor: ActorContext,
  body: unknown,
): VocabularyTag {
  const record = asRecord(body);

  if (typeof record.label !== "string") {
    throw new ValidationError("label 必须是字符串", { field: "label" });
  }

  const label = displayTagLabel(record.label);
  const problem = tagLabelProblem(label);

  if (problem) {
    throw new ValidationError(problem, { field: "label", max: MAX_TAG_LENGTH });
  }

  const normalized = normalizeTag(label);
  const existing = findTagByNormalized(db, normalized);

  // 归一化命中即复用已有标签（R2：重复不报错）。
  if (existing) {
    return {
      id: existing.id,
      label: existing.label,
      normalized: existing.normalized,
      sortOrder: existing.sortOrder,
      usage: tagUsage(db, existing.id),
    };
  }

  const total = db.select({ count: sql<number>`count(*)` }).from(tags).get()?.count ?? 0;
  const now = nowIso();
  const id = ulid();
  const source = readSource(record);

  db.transaction((tx) => {
    tx.insert(tags)
      .values({ id, label, normalized, sortOrder: 0, createdAt: now, updatedAt: now })
      .run();

    writeAudit(tx, {
      actor,
      action: "vocabulary.tag.create",
      targetType: "tag",
      targetId: id,
      detail: { label, normalized, source },
      createdAt: now,
    });
  });

  return {
    id,
    label,
    normalized,
    sortOrder: 0,
    usage: 0,
    // 软上限只警告不拦（R2）；用返回值里的标记让调用方可以提示。
    ...(Number(total) >= TAG_SOFT_LIMIT ? { warning: "标签总数已超过建议上限，建议合并同义标签" } : {}),
  } as VocabularyTag;
}

export function updateTag(
  db: AppDatabase,
  actor: ActorContext,
  tagId: string,
  body: unknown,
): VocabularyTag {
  const record = asRecord(body);
  const current = db.select().from(tags).where(eq(tags.id, tagId)).get();

  if (!current) {
    throw new NotFoundError("标签不存在", { id: tagId });
  }

  if (typeof record.label !== "string") {
    throw new ValidationError("label 必须是字符串", { field: "label" });
  }

  const label = displayTagLabel(record.label);
  const problem = tagLabelProblem(label);

  if (problem) {
    throw new ValidationError(problem, { field: "label", max: MAX_TAG_LENGTH });
  }

  const normalized = normalizeTag(label);
  const clash = findTagByNormalized(db, normalized);

  if (clash && clash.id !== tagId) {
    throw new ConflictError("已有同名标签，可改用合并", {
      normalized,
      existing: { id: clash.id, label: clash.label },
    });
  }

  const updatedAt = nowIso();

  db.transaction((tx) => {
    tx.update(tags)
      .set({ label, normalized, updatedAt })
      .where(eq(tags.id, tagId))
      .run();

    writeAudit(tx, {
      actor,
      action: "vocabulary.tag.update",
      targetType: "tag",
      targetId: tagId,
      detail: { from: current.label, to: label },
      createdAt: updatedAt,
    });
  });

  return {
    id: tagId,
    label,
    normalized,
    sortOrder: current.sortOrder,
    usage: tagUsage(db, tagId),
  };
}

export interface DeleteTagOptions {
  /** 勾选「同时从对象移除」时为 true；默认只拒绝，不动对象。 */
  removeFromObjects?: boolean;
}

export function deleteTag(
  db: AppDatabase,
  actor: ActorContext,
  tagId: string,
  options: DeleteTagOptions = {},
): { deleted: string; removedFrom: number } {
  const current = db.select().from(tags).where(eq(tags.id, tagId)).get();

  if (!current) {
    throw new NotFoundError("标签不存在", { id: tagId });
  }

  const usage = tagUsage(db, tagId);

  if (usage > 0 && !options.removeFromObjects) {
    throw new ConflictError(`该标签还被 ${usage} 个内容使用，可改为合并`, {
      id: tagId,
      usage,
    });
  }

  const now = nowIso();

  db.transaction((tx) => {
    tx.delete(objectTags).where(eq(objectTags.tagId, tagId)).run();
    tx.delete(tags).where(eq(tags.id, tagId)).run();

    writeAudit(tx, {
      actor,
      action: "vocabulary.tag.delete",
      targetType: "tag",
      targetId: tagId,
      detail: {
        label: current.label,
        usage,
        removedFromObjects: Boolean(options.removeFromObjects),
      },
      createdAt: now,
    });
  });

  return { deleted: tagId, removedFrom: options.removeFromObjects ? usage : 0 };
}

export interface MergeTagInput {
  /** 目标标签的 id 或名称（名称会先归一化）。二选一。 */
  targetId?: string;
  targetLabel?: string;
}

export function mergeTag(
  db: AppDatabase,
  actor: ActorContext,
  sourceId: string,
  body: unknown,
): VocabularyTag {
  const record = asRecord(body);
  const source = db.select().from(tags).where(eq(tags.id, sourceId)).get();

  if (!source) {
    throw new NotFoundError("标签不存在", { id: sourceId });
  }

  let target = null;

  if (typeof record.targetId === "string") {
    target = db.select().from(tags).where(eq(tags.id, record.targetId)).get() ?? null;
  } else if (typeof record.targetLabel === "string") {
    target = findTagByNormalized(db, normalizeTag(record.targetLabel)) ?? null;
  }

  if (!target) {
    throw new ValidationError("合并目标不存在", { field: "targetId" });
  }

  if (target.id === source.id) {
    throw new ValidationError("合并目标不能是自己", { id: sourceId });
  }

  const links = db
    .select({ objectId: objectTags.objectId })
    .from(objectTags)
    .where(eq(objectTags.tagId, source.id))
    .all();

  db.transaction((tx) => {
    for (const link of links) {
      tx.insert(objectTags)
        .values({ objectId: link.objectId, tagId: target.id })
        .onConflictDoNothing()
        .run();
    }

    tx.delete(objectTags).where(eq(objectTags.tagId, source.id)).run();
    tx.delete(tags).where(eq(tags.id, source.id)).run();

    writeAudit(tx, {
      actor,
      action: "vocabulary.tag.merge",
      targetType: "tag",
      targetId: target.id,
      detail: { from: source.label, to: target.label, moved: links.length },
      createdAt: nowIso(),
    });
  });

  return {
    id: target.id,
    label: target.label,
    normalized: target.normalized,
    sortOrder: target.sortOrder,
    usage: tagUsage(db, target.id),
  };
}
