import { ConflictError, ValidationError } from "../../domain/errors";
import {
  isAssetUsageKind,
  type AssetUsageKind,
  type BusinessObject,
  type ValueLevel,
} from "../../domain/objects";
import { planDynamicAdjustment, valueScoreRecord } from "../../domain/value";
import type { ActorContext } from "../authz";
import type { AppDatabase } from "../db/client";
import type { RecordUsageResult } from "../ports/object-repository";
import { SqliteObjectRepository } from "../repositories/sqlite-object-repository";
import { getObject } from "./object-service";

/**
 * 「有效调用」与动态升降级（规格 v2.1 §2）。
 *
 * 边界：
 * - 一次调用 = 详情停留 / 打开原文 / 复制 / 引用，由前端在明确动作时上报；
 * - 同一 asset + kind + actor 1 小时内只计一次（防抖，不是防作弊）；
 * - 升降级只替换复用维度后按同一套阈值重算，等级永远由分数推导；
 * - 锁定、24 小时节流、降级优先的规则都在 `domain/value.ts`，这里只取数据。
 */

/** 1 小时内同动作同人不重复计数。 */
const USAGE_DEDUPE_WINDOW_MS = 60 * 60 * 1_000;

/** 近 30 天 = 复用维度与升级判定的观察窗口。 */
const USAGE_REVIEW_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) return {};

  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("请求体必须是 JSON 对象");
  }

  return body as Record<string, unknown>;
}

export function parseUsageKind(body: unknown): AssetUsageKind {  const record = asRecord(body);
  const kind = record.kind;

  if (!isAssetUsageKind(kind)) {
    throw new ValidationError("kind 取值非法", {
      field: "kind",
      allowed: ["detail_dwell", "open_source", "copy", "reference"],
    });
  }

  return kind;
}

function daysBetween(fromIso: string | null, nowMs: number): number | null {
  if (!fromIso) return null;

  const fromMs = Date.parse(fromIso);

  if (!Number.isFinite(fromMs)) return null;

  return Math.max(0, Math.floor((nowMs - fromMs) / MS_PER_DAY));
}

export interface RecordUsageOptions {
  now?: string;
}

/**
 * 记录一次有效调用。1 小时内重复上报返回当前对象、`recorded: false`，
 * 既不报错也不重复计数（前端下拉详情时可能触发多次）。
 */
export async function recordAssetUsage(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  body: unknown,
  options: RecordUsageOptions = {},
): Promise<RecordUsageResult> {
  const kind = parseUsageKind(body);
  const asset = await getObject(db, actor.sub, objectId);

  if (asset.type !== "asset") {
    throw new ConflictError("只有资产可以记录使用", {
      id: objectId,
      type: asset.type,
    });
  }

  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const since = new Date(nowMs - USAGE_DEDUPE_WINDOW_MS).toISOString();
  const repo = new SqliteObjectRepository(db);
  const recent = await repo.findUsageInWindow(objectId, since);
  const duplicated = recent.some(
    (event) => event.kind === kind && event.actorSub === actor.sub,
  );

  if (duplicated) {
    return { object: asset, recorded: false };
  }

  return repo.recordUsage({ assetId: objectId, kind, actor, now });
}

export function parseLockFlag(body: unknown): boolean {
  const record = asRecord(body);
  const locked = record.locked;

  if (typeof locked !== "boolean") {
    throw new ValidationError("locked 必须是布尔值", { field: "locked" });
  }

  return locked;
}

/** 手动锁定 / 解锁等级：锁定后自动升降级一律跳过该资产。 */
export async function setAssetValueLock(
  db: AppDatabase,
  actor: ActorContext,
  objectId: string,
  body: unknown,
): Promise<BusinessObject> {
  const locked = parseLockFlag(body);
  const asset = await getObject(db, actor.sub, objectId);

  if (asset.type !== "asset") {
    throw new ConflictError("只有资产可以锁定等级", { id: objectId, type: asset.type });
  }

  return new SqliteObjectRepository(db).setValueLock({
    objectId,
    locked,
    actor,
  });
}

export interface UsageReviewItem {
  id: string;
  title: string;
  from: ValueLevel;
  to: ValueLevel;
  trigger: "auto_upgrade" | "auto_downgrade";
  reason: string;
}

export interface UsageReviewResult {
  scanned: number;
  adjusted: number;
  skippedLocked: number;
  failed: { id: string; title: string; message: string }[];
  items: UsageReviewItem[];
}

export interface UsageReviewOptions {
  now?: string;
  /** 一次最多扫多少条内库资产（默认 1000）；超出部分留给下一次。 */
  limit?: number;
}

/**
 * 使用度复核：遍历内库资产，按 30 天调用与闲置天数做一次自动升降级。
 *
 * 逐条独立提交：一条失败不影响其他条；失败原因带对象标题一并返回。
 * 管理员手动触发（没有后台定时任务），重复执行由 24 小时节流兜底。
 */
export async function runUsageReview(
  db: AppDatabase,
  actor: ActorContext,
  options: UsageReviewOptions = {},
): Promise<UsageReviewResult> {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const repo = new SqliteObjectRepository(db);
  const assets = await repo.list({
    type: "asset",
    library: "internal",
    limit: options.limit ?? 1_000,
  });
  const since30 = new Date(nowMs - USAGE_REVIEW_WINDOW_DAYS * MS_PER_DAY).toISOString();

  const result: UsageReviewResult = {
    scanned: 0,
    adjusted: 0,
    skippedLocked: 0,
    failed: [],
    items: [],
  };

  for (const asset of assets) {
    result.scanned += 1;

    if (asset.valueLevelLocked) {
      result.skippedLocked += 1;
      continue;
    }

    if (!asset.valueLevel || !asset.valueScores) continue;

    const events = await repo.findUsageInWindow(asset.id, since30);
    const adjustment = planDynamicAdjustment({
      currentLevel: asset.valueLevel,
      scores: valueScoreRecord(asset.valueScores),
      useCount30d: events.length,
      daysSinceLastUse: daysBetween(asset.lastUsedAt ?? asset.createdAt, nowMs),
      locked: asset.valueLevelLocked,
      lastAdjustedAt: asset.lastLevelAdjustAt,
      now,
    });

    if (!adjustment) continue;

    try {
      await repo.applyValueAssessment({
        objectId: asset.id,
        expectedRevision: asset.revision,
        assessment: {
          valueLevel: adjustment.level,
          valueScores: adjustment.scores,
          valueAssessedAt: now,
        },
        actor,
        trigger: adjustment.type === "upgrade" ? "auto_upgrade" : "auto_downgrade",
        reason: adjustment.reason,
        assessedBy: "system",
        markLevelAdjusted: true,
        now,
      });

      result.adjusted += 1;
      result.items.push({
        id: asset.id,
        title: asset.title,
        from: asset.valueLevel,
        to: adjustment.level,
        trigger: adjustment.type === "upgrade" ? "auto_upgrade" : "auto_downgrade",
        reason: adjustment.reason,
      });
    } catch (error) {
      result.failed.push({
        id: asset.id,
        title: asset.title,
        message: error instanceof Error ? error.message : "自动调整失败",
      });
    }
  }

  return result;
}
