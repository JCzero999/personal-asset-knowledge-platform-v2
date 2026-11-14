import { DomainError, NotFoundError, ValidationError } from "../../domain/errors";
import {
  isAiStatus,
  isLibrary,
  isObjectType,
  isValueLevel,
  isWorkStatus,
  libraries,
  workStatuses,
  objectOrigins,
  priorities,
  type BusinessObject,
  type Library,
  type ObjectOrigin,
  type ObjectSource,
  type ObjectType,
  type Priority,
  type WorkStatus,
} from "../../domain/objects";
import {
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_OBJECT,
  normalizeTagList,
  tagLabelProblem,
} from "../../domain/vocabulary";
import type { ActorContext } from "../authz";
import type { AppDatabase } from "../db/client";
import type {
  CreateObjectInput,
  LibraryChangeEvent,
  ListObjectsQuery,
  UpdateObjectInput,
} from "../ports/object-repository";
import { SqliteObjectRepository } from "../repositories/sqlite-object-repository";
import { evaluateValueScores } from "./asset-ai";
import { listActiveCategoryCodes } from "./vocabulary-service";

/**
 * 业务对象服务：把 HTTP 输入收敛成合法的创建参数，再交给仓储。
 * 不做权限与外部调用；内容同步（RAGFlow）留给 Phase 2 的 outbox。
 */

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5_000;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("请求体必须是 JSON 对象");
  }

  return body as Record<string, unknown>;
}

function readString(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) {
      throw new ValidationError(`${field} 不能为空`, { field });
    }
    return null;
  }

  if (typeof value !== "string") {
    throw new ValidationError(`${field} 必须是字符串`, { field });
  }

  const trimmed = value.trim();

  if (!trimmed && required) {
    throw new ValidationError(`${field} 不能为空`, { field });
  }

  if (trimmed.length > max) {
    throw new ValidationError(`${field} 不能超过 ${max} 个字符`, { field, max });
  }

  return trimmed || null;
}

/**
 * 标签：先按全局归一化规则去重（R2 规则 1–5），再校验长度与数量。
 * 标签的真相源是 `object_tags`，写入由仓储在事务里完成。
 */
function readTags(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ValidationError("tags 必须是字符串数组", { field: "tags" });
  }

  const cleaned = normalizeTagList(value as string[]);

  for (const label of cleaned) {
    const problem = tagLabelProblem(label);

    if (problem) {
      throw new ValidationError(problem, { field: "tags", tag: label, max: MAX_TAG_LENGTH });
    }
  }

  if (cleaned.length > MAX_TAGS_PER_OBJECT) {
    throw new ValidationError(`最多 ${MAX_TAGS_PER_OBJECT} 个标签`, {
      field: "tags",
      max: MAX_TAGS_PER_OBJECT,
    });
  }

  return cleaned;
}

function readEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  if (value === undefined || value === null) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new ValidationError(`${field} 不能为空`, { field, allowed });
  }

  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} 取值非法`, { field, allowed });
  }

  return value as T;
}

/**
 * ADR-023：`format` / `categories` 已合并为单值 `category`。
 * 旧客户端若继续提交旧字段，直接报错而不是静默丢弃——否则用户会以为改成功了。
 */
function rejectLegacyCategoryFields(record: Record<string, unknown>): void {
  if ("format" in record) {
    throw new ValidationError("format 已更名为 category（分类）", { field: "format" });
  }

  if ("categories" in record) {
    throw new ValidationError("一个对象只能属于一个分类，请改用 category", {
      field: "categories",
    });
  }
}

export interface CreateObjectParams extends Omit<CreateObjectInput, "ownerSub"> {
  ownerSub: string;
}

/** 把外部请求体解析成创建参数；作品固定从 draft 开始，不接受外部指定状态。 */
export function parseCreateObjectBody(body: unknown, ownerSub: string): CreateObjectParams {
  const record = asRecord(body);
  rejectLegacyCategoryFields(record);
  const type: ObjectType = readEnum(record.type, "type", ["asset", "work"] as const);
  const library: Library = readEnum(record.library, "library", libraries);
  const title = readString(record.title, "title", MAX_TITLE, true) as string;
  const description = readString(record.description, "description", MAX_DESCRIPTION);
  const tags = readTags(record.tags);
  const priority: Priority = readEnum(record.priority, "priority", priorities, "medium");
  const source = record.source === undefined
    ? undefined
    : readEnum<ObjectSource>(record.source, "source", ["handwritten", "ai_extracted"]);
  const origin = record.origin === undefined
    ? undefined
    : readEnum<ObjectOrigin>(record.origin, "origin", objectOrigins);

  const base: CreateObjectParams = {
    type,
    title,
    description,
    library,
    tags,
    priority,
    ownerSub,
    ...(source ? { source } : {}),
    ...(origin ? { origin } : {}),
  };

  // 分类（ADR-023）：作品必填、资产可空。这里只检查「是个非空 code」，
  // 是否存在 / 是否启用由 createObject / updateObject 查词表判定。
  const category = readString(record.category, "category", 64);

  if (type === "asset") {
    return { ...base, ...(category ? { category } : {}) };
  }

  if (!category) {
    throw new ValidationError("作品必须选择一个分类", { field: "category" });
  }

  if (record.status !== undefined && record.status !== null) {
    throw new ValidationError("新建作品固定从 draft 开始，状态迁移请用专用接口", {
      field: "status",
    });
  }

  return {
    ...base,
    category,
    sourceNote: readString(record.sourceNote, "sourceNote", MAX_DESCRIPTION),
  };
}

export async function createObject(
  db: AppDatabase,
  actor: ActorContext,
  body: unknown,
): Promise<BusinessObject> {
  const params = parseCreateObjectBody(body, actor.sub);

  // 作品只存在于外库（规格 v2.0 第 3、7 节）：服务层先挡一次，仓储与 CHECK 再兜底。
  if (params.type === "work" && params.library !== "external") {
    throw new DomainError("WORK_MUST_BE_EXTERNAL", "作品只存在于外库，不能直接建在内库", {
      library: params.library,
    });
  }

  // 停用 / 不存在的分类拒绝新建；资产没有分类时跳过。
  if (params.category && !listActiveCategoryCodes(db).includes(params.category)) {
    throw new NotFoundError("分类不存在或已停用", { category: params.category });
  }

  // 内库资产必须在创建时就带 5 维评估与等级（规格第 6 节）：模型不可用时
  // 退回确定性兜底，保证「内库资产一定有等级」这条硬规则不被一次模型抖动打破。
  if (params.type === "asset" && params.library === "internal") {
    const scores = await evaluateValueScores(
      db,
      {
        title: params.title,
        description: params.description ?? null,
        tags: params.tags ?? [],
      },
      {},
      { fallbackOnError: true },
    );

    return new SqliteObjectRepository(db).create({
      ...params,
      valueLevel: scores.level,
      valueScores: scores,
      valueAssessedAt: scores.assessedAt,
    });
  }

  return new SqliteObjectRepository(db).create(params);
}

export interface ChangeStatusParams {
  to: WorkStatus;
  expectedRevision?: number;
}

/** 状态迁移请求体：只接受目标状态与可选的乐观锁版本号。 */
export function parseChangeStatusBody(body: unknown): ChangeStatusParams {
  const record = asRecord(body);
  const to = readEnum<WorkStatus>(record.to, "to", workStatuses);
  const expected = record.expectedRevision;

  if (expected === undefined || expected === null) {
    return { to };
  }

  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
    throw new ValidationError("expectedRevision 必须是正整数", { field: "expectedRevision" });
  }

  return { to, expectedRevision: expected };
}

/** 单用户阶段也按 ownerSub 过滤：别人的对象一律当作不存在，避免通过 id 探测。 */
async function requireOwned(
  repo: SqliteObjectRepository,
  ownerSub: string,
  objectId: string,
): Promise<BusinessObject> {
  const current = await repo.findById(objectId);

  if (!current || current.ownerSub !== ownerSub) {
    throw new NotFoundError("对象不存在或已删除", { id: objectId });
  }

  return current;
}

/**
 * 迁移作品状态。单用户阶段也按 ownerSub 过滤：别人的对象一律当作不存在，
 * 避免通过 id 探测他人数据。
 */
export async function changeObjectStatus(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  body: unknown,
): Promise<BusinessObject> {
  const repo = new SqliteObjectRepository(db);
  await requireOwned(repo, actor.sub, objectId);

  return repo.changeStatus({ objectId, ...parseChangeStatusBody(body) });
}

const immutableUpdateFields = ["type", "library", "status"] as const;

/** 编辑请求体：可改字段都按「缺席不变、显式 null 清空」处理。 */
export function parseUpdateObjectBody(body: unknown): UpdateObjectInput {
  const record = asRecord(body);
  rejectLegacyCategoryFields(record);
  const expected = record.expectedRevision;

  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
    throw new ValidationError("expectedRevision 必须是正整数", { field: "expectedRevision" });
  }

  for (const field of immutableUpdateFields) {
    if (field in record) {
      throw new ValidationError(`${field} 不能通过编辑接口修改`, { field });
    }
  }

  const patch: UpdateObjectInput = { expectedRevision: expected };

  if ("title" in record) {
    patch.title = readString(record.title, "title", MAX_TITLE, true) as string;
  }
  if ("description" in record) {
    patch.description = readString(record.description, "description", MAX_DESCRIPTION);
  }
  if ("category" in record) {
    // 显式 null 表示清空分类，只有资产允许；作品的分类型约束由仓储兜底。
    patch.category = record.category === null ? null : readString(record.category, "category", 64);
  }
  if ("tags" in record) {
    patch.tags = readTags(record.tags);
  }
  if ("priority" in record) {
    patch.priority = readEnum(record.priority, "priority", priorities);
  }
  if ("source" in record) {
    patch.source = readEnum<ObjectSource>(record.source, "source", ["handwritten", "ai_extracted"]);
  }
  if ("origin" in record) {
    patch.origin = readEnum<ObjectOrigin>(record.origin, "origin", objectOrigins);
  }
  if ("sourceNote" in record) {
    patch.sourceNote = readString(record.sourceNote, "sourceNote", MAX_DESCRIPTION);
  }

  return patch;
}

export async function updateObject(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  body: unknown,
): Promise<BusinessObject> {
  const repo = new SqliteObjectRepository(db);
  const current = await requireOwned(repo, actor.sub, objectId);
  const patch = parseUpdateObjectBody(body);

  // 停用分类允许「保持原值」，但不允许把对象改成停用 / 不存在的分类。
  if (patch.category !== undefined && patch.category !== null && patch.category !== current.category) {
    if (!listActiveCategoryCodes(db).includes(patch.category)) {
      throw new NotFoundError("分类不存在或已停用", { category: patch.category });
    }
  }

  return repo.update(objectId, patch);
}

export async function deleteObject(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
): Promise<void> {
  const repo = new SqliteObjectRepository(db);
  await requireOwned(repo, actor.sub, objectId);
  await repo.softDelete(objectId, undefined, actor);
}

export interface ChangeLibraryParams {
  to: Library;
  reason: string;
  expectedRevision?: number;
}

/** 跨库迁移请求体：理由必填，它是「内库 = 已验证」承诺的审计依据。 */
export function parseChangeLibraryBody(body: unknown): ChangeLibraryParams {
  const record = asRecord(body);
  const to = readEnum<Library>(record.to, "to", libraries);
  const reason = readString(record.reason, "reason", MAX_DESCRIPTION, true) as string;
  const expected = record.expectedRevision;

  if (expected === undefined || expected === null) {
    return { to, reason };
  }

  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
    throw new ValidationError("expectedRevision 必须是正整数", { field: "expectedRevision" });
  }

  return { to, reason, expectedRevision: expected };
}

export async function changeObjectLibrary(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  body: unknown,
): Promise<BusinessObject> {
  const repo = new SqliteObjectRepository(db);
  await requireOwned(repo, actor.sub, objectId);

  return repo.changeLibrary({
    objectId,
    actorSub: actor.sub,
    actorUserId: actor.userId,
    ...parseChangeLibraryBody(body),
  });
}

/** 归档 / 取消归档：请求体 `{ "archived": true | false }`。 */
export async function setObjectArchived(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  body: unknown,
): Promise<BusinessObject> {
  const record = asRecord(body);

  if (typeof record.archived !== "boolean") {
    throw new ValidationError("archived 必须是布尔值", { field: "archived" });
  }

  const repo = new SqliteObjectRepository(db);
  await requireOwned(repo, actor.sub, objectId);

  return record.archived
    ? repo.archive(objectId, undefined, actor)
    : repo.unarchive(objectId, undefined, actor);
}

/** 列表筛选参数只接受已知取值，非法值直接报错，不做静默忽略。 */
export function parseListObjectsQuery(searchParams: URLSearchParams): ListObjectsQuery {
  const query: ListObjectsQuery = {};

  const type = searchParams.get("type");
  if (type) {
    if (!isObjectType(type)) {
      throw new ValidationError("type 取值非法", { field: "type" });
    }
    query.type = type;
  }

  const library = searchParams.get("library");
  if (library) {
    if (!isLibrary(library)) {
      throw new ValidationError("library 取值非法", { field: "library" });
    }
    query.library = library;
  }

  const status = searchParams.get("status");
  if (status) {
    if (!isWorkStatus(status)) {
      throw new ValidationError("status 取值非法", { field: "status" });
    }
    query.status = status;
  }

  const aiStatus = searchParams.get("aiStatus");
  if (aiStatus) {
    if (!isAiStatus(aiStatus)) {
      throw new ValidationError("aiStatus 取值非法", { field: "aiStatus" });
    }
    query.aiStatus = aiStatus;
  }

  const valueLevel = searchParams.get("valueLevel");
  if (valueLevel) {
    if (!isValueLevel(valueLevel)) {
      throw new ValidationError("valueLevel 取值非法", { field: "valueLevel" });
    }
    query.valueLevel = valueLevel;
  }

  const search = searchParams.get("q")?.trim();
  if (search) {
    if (search.length > 100) {
      throw new ValidationError("q 最长 100 个字符", { field: "q" });
    }
    query.search = search;
  }

  for (const field of ["category", "tag"] as const) {
    const value = searchParams.get(field)?.trim();
    if (value) {
      if (value.length > 64) {
        throw new ValidationError(`${field} 最长 64 个字符`, { field });
      }
      query[field] = value;
    }
  }

  const sort = searchParams.get("sort");
  if (sort) {
    if (sort !== "updated" && sort !== "created" && sort !== "title") {
      throw new ValidationError("sort 取值非法", { field: "sort" });
    }
    query.sort = sort;
  }

  const limit = readPositiveInt(searchParams.get("limit"), "limit", 200);
  if (limit !== undefined) {
    query.limit = limit;
  }

  const offset = readNonNegativeInt(searchParams.get("offset"), "offset");
  if (offset !== undefined) {
    query.offset = offset;
  }

  const archived = searchParams.get("archived");
  if (archived !== null) {
    if (archived === "true") {
      query.includeArchived = true;
    } else if (archived === "only") {
      query.archivedOnly = true;
    } else if (archived !== "false") {
      throw new ValidationError("archived 取值非法", { field: "archived", allowed: ["true", "false", "only"] });
    }
  }

  return query;
}

function readPositiveInt(
  raw: string | null,
  field: string,
  max: number,
): number | undefined {
  if (raw === null || raw.trim() === "") {
    return undefined;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`${field} 必须是 1~${max} 的整数`, { field });
  }

  return value;
}

function readNonNegativeInt(raw: string | null, field: string): number | undefined {
  if (raw === null || raw.trim() === "") {
    return undefined;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} 必须是非负整数`, { field });
  }

  return value;
}

export async function listObjects(
  db: AppDatabase,
  query: ListObjectsQuery = {},
): Promise<BusinessObject[]> {
  return new SqliteObjectRepository(db).list(query);
}

export async function getObject(
  db: AppDatabase,
  ownerSub: string,
  objectId: string,
): Promise<BusinessObject> {
  const repo = new SqliteObjectRepository(db);
  return requireOwned(repo, ownerSub, objectId);
}

/** 跨库迁移审计：按身份校验归属后返回该对象的全部迁移记录。 */
export async function listObjectLibraryEvents(
  db: AppDatabase,
  ownerSub: string,
  objectId: string,
): Promise<LibraryChangeEvent[]> {
  const repo = new SqliteObjectRepository(db);
  await requireOwned(repo, ownerSub, objectId);
  return repo.listLibraryEvents(objectId);
}
