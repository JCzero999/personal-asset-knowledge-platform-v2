import { ValidationError } from "../../domain/errors";
import {
  isLibrary,
  isObjectType,
  libraries,
  workFormatValues,
  objectOrigins,
  priorities,
  type BusinessObject,
  type Library,
  type ObjectOrigin,
  type ObjectSource,
  type ObjectType,
  type Priority,
  type WorkFormat,
} from "../../domain/objects";
import type { AppDatabase } from "../db/client";
import type { CreateObjectInput, ListObjectsQuery } from "../ports/object-repository";
import { SqliteObjectRepository } from "../repositories/sqlite-object-repository";

/**
 * 业务对象服务：把 HTTP 输入收敛成合法的创建参数，再交给仓储。
 * 不做权限与外部调用；内容同步（RAGFlow）留给 Phase 2 的 outbox。
 */

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5_000;
const MAX_COLLECTION_ITEMS = 20;
const MAX_ITEM_LENGTH = 40;

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

function readList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ValidationError(`${field} 必须是字符串数组`, { field });
  }

  const cleaned = value
    .map((item) => (item as string).trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      if (item.length > MAX_ITEM_LENGTH) {
        throw new ValidationError(`${field} 的单项不能超过 ${MAX_ITEM_LENGTH} 个字符`, {
          field,
          item,
        });
      }
      return item;
    });

  const unique = [...new Set(cleaned)];

  if (unique.length > MAX_COLLECTION_ITEMS) {
    throw new ValidationError(`${field} 最多 ${MAX_COLLECTION_ITEMS} 项`, { field });
  }

  return unique;
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

export interface CreateObjectParams extends Omit<CreateObjectInput, "ownerSub"> {
  ownerSub: string;
}

/** 把外部请求体解析成创建参数；作品固定从 draft 开始，不接受外部指定状态。 */
export function parseCreateObjectBody(body: unknown, ownerSub: string): CreateObjectParams {
  const record = asRecord(body);
  const type: ObjectType = readEnum(record.type, "type", ["asset", "work"] as const);
  const library: Library = readEnum(record.library, "library", libraries);
  const title = readString(record.title, "title", MAX_TITLE, true) as string;
  const description = readString(record.description, "description", MAX_DESCRIPTION);
  const categories = readList(record.categories, "categories");
  const tags = readList(record.tags, "tags");
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
    categories,
    tags,
    priority,
    ownerSub,
    ...(source ? { source } : {}),
    ...(origin ? { origin } : {}),
  };

  if (type === "asset") {
    if (record.format !== undefined && record.format !== null) {
      throw new ValidationError("资产没有 format 字段", { field: "format" });
    }
    return base;
  }

  const format: WorkFormat = readEnum<WorkFormat>(record.format, "format", workFormatValues);

  if (record.status !== undefined && record.status !== null && record.status !== "draft") {
    throw new ValidationError("新建作品固定从 draft 开始，状态迁移请用专用接口", {
      field: "status",
    });
  }

  return {
    ...base,
    format,
    status: "draft",
    sourceNote: readString(record.sourceNote, "sourceNote", MAX_DESCRIPTION),
  };
}

export async function createObject(
  db: AppDatabase,
  ownerSub: string,
  body: unknown,
): Promise<BusinessObject> {
  const params = parseCreateObjectBody(body, ownerSub);
  return new SqliteObjectRepository(db).create(params);
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

  if (searchParams.get("archived") === "true") {
    query.includeArchived = true;
  }

  return query;
}

export async function listObjects(
  db: AppDatabase,
  query: ListObjectsQuery = {},
): Promise<BusinessObject[]> {
  return new SqliteObjectRepository(db).list(query);
}
