import { ValidationError } from "../../domain/errors";
import { isValueLevel, type ValueLevel } from "../../domain/objects";
import type { ValueScores } from "../../domain/value";
import type { ActorContext } from "../authz";
import type { AppDatabase } from "../db/client";
import { SqliteObjectRepository } from "../repositories/sqlite-object-repository";
import { writeAudit } from "./audit-service";
import { assessAssetValue, type AssetServiceDeps } from "./asset-service";

/**
 * 批量重评（v2.1 §5）：按 id 或按等级 / 来源筛选内库资产，逐条重新跑模型。
 *
 * 逐条独立：一条失败不影响其余条，失败原因写审计（`value.reassess_failed`），
 * 后台指标直接按这条审计计数。一次最多 50 条，避免一把把模型额度烧光。
 */

const MAX_REASSESS = 50;
const SOURCE_VALUES: readonly NonNullable<ValueScores["source"]>[] = [
  "model",
  "fallback",
  "rule",
  "migration",
];

export interface ReassessFilter {
  level?: ValueLevel;
  source?: NonNullable<ValueScores["source"]>;
}

export interface ReassessSelection {
  ids?: string[];
  filter: ReassessFilter;
}

export interface ReassessResult {
  ok: { id: string; title: string; valueLevel: ValueLevel | null }[];
  failed: { id: string; message: string }[];
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) return {};

  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("请求体必须是 JSON 对象");
  }

  return body as Record<string, unknown>;
}

export function parseReassessBody(body: unknown): ReassessSelection {
  const record = asRecord(body);
  const filterRaw = record.filter;
  const filter: ReassessFilter = {};

  if (filterRaw !== undefined && filterRaw !== null) {
    if (typeof filterRaw !== "object" || Array.isArray(filterRaw)) {
      throw new ValidationError("filter 必须是对象", { field: "filter" });
    }

    const sourceValue = (filterRaw as Record<string, unknown>).source;

    if (sourceValue !== undefined && sourceValue !== null) {
      if (!SOURCE_VALUES.includes(sourceValue as NonNullable<ValueScores["source"]>)) {
        throw new ValidationError("filter.source 取值非法", {
          field: "filter.source",
          allowed: SOURCE_VALUES,
        });
      }
      filter.source = sourceValue as NonNullable<ValueScores["source"]>;
    }

    const level = (filterRaw as Record<string, unknown>).level;

    if (level !== undefined && level !== null) {
      if (!isValueLevel(level)) {
        throw new ValidationError("filter.level 取值非法", {
          field: "filter.level",
          allowed: ["S", "A", "B", "C"],
        });
      }
      filter.level = level;
    }
  }

  const idsRaw = record.ids;

  if (idsRaw === undefined || idsRaw === null) {
    return { filter };
  }

  if (!Array.isArray(idsRaw)) {
    throw new ValidationError("ids 必须是数组", { field: "ids" });
  }

  const ids = [
    ...new Set(
      idsRaw
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];

  if (ids.length !== idsRaw.length) {
    throw new ValidationError("ids 只能是非空字符串且不重复", { field: "ids" });
  }

  if (ids.length === 0) {
    throw new ValidationError("ids 不能为空", { field: "ids" });
  }

  if (ids.length > MAX_REASSESS) {
    throw new ValidationError(`一次最多重评 ${MAX_REASSESS} 条`, { field: "ids" });
  }

  return { ids, filter };
}

async function selectIds(
  db: AppDatabase,
  actor: ActorContext,
  selection: ReassessSelection,
): Promise<string[]> {
  if (selection.ids) return selection.ids;

  const assets = await new SqliteObjectRepository(db).list({
    ownerSub: actor.sub,
    type: "asset",
    library: "internal",
    valueLevel: selection.filter.level,
    limit: 200,
  });
  const matched = selection.filter.source
    ? assets.filter((asset) => asset.valueScores?.source === selection.filter.source)
    : assets;

  return matched.slice(0, MAX_REASSESS).map((asset) => asset.id);
}

export async function reassessAssets(
  db: AppDatabase,
  actor: ActorContext,
  body: unknown,
  deps: AssetServiceDeps = {},
): Promise<ReassessResult> {
  const selection = parseReassessBody(body);
  const ids = await selectIds(db, actor, selection);
  const result: ReassessResult = { ok: [], failed: [] };

  for (const id of ids) {
    try {
      const asset = await assessAssetValue(db, actor, id, deps);
      result.ok.push({ id, title: asset.title, valueLevel: asset.valueLevel });
    } catch (error) {
      const message = error instanceof Error ? error.message : "重评失败";
      result.failed.push({ id, message });

      try {
        writeAudit(db, {
          actor,
          action: "value.reassess_failed",
          targetType: "asset",
          targetId: id,
          detail: { message },
          result: "error",
        });
      } catch (auditError) {
        console.error("[reassess] 写失败审计时出错", auditError);
      }
    }
  }

  return result;
}
