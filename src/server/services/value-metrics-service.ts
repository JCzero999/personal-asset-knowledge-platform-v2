import { and, eq, gte, isNull, sql } from "drizzle-orm";

import type { ValueLevel } from "../../domain/objects";
import type { AppDatabase } from "../db/client";
import { auditEvents, objects } from "../db/schema";

/**
 * 价值兜底监控（v2.1 §5）：首页 / 后台只看这几个数就能发现「模型又挂了」。
 *
 * 「今天」按 UTC 零点切分（与全站审计时间一致），7 天窗口按 7×24 小时算。
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface ValueMetrics {
  fallbackToday: number;
  fallback7d: number;
  reassessFailed7d: number;
  levelDistribution: Record<ValueLevel, number>;
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function countAuditErrors(db: AppDatabase, action: string, sinceIso: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, action),
        eq(auditEvents.result, "error"),
        gte(auditEvents.createdAt, sinceIso),
      ),
    )
    .get();

  return Number(row?.n ?? 0);
}

export function getValueMetrics(db: AppDatabase, now: Date = new Date()): ValueMetrics {
  const distribution: Record<ValueLevel, number> = { S: 0, A: 0, B: 0, C: 0 };
  const rows = db
    .select({ level: objects.valueLevel, n: sql<number>`count(*)` })
    .from(objects)
    .where(
      and(
        eq(objects.type, "asset"),
        eq(objects.library, "internal"),
        isNull(objects.deletedAt),
      ),
    )
    .groupBy(objects.valueLevel)
    .all();

  for (const row of rows) {
    if (row.level && row.level in distribution) {
      distribution[row.level as ValueLevel] = Number(row.n);
    }
  }

  return {
    fallbackToday: countAuditErrors(db, "value.fallback", utcDayStart(now)),
    fallback7d: countAuditErrors(db, "value.fallback", new Date(now.getTime() - 7 * DAY_MS).toISOString()),
    reassessFailed7d: countAuditErrors(
      db,
      "value.reassess_failed",
      new Date(now.getTime() - 7 * DAY_MS).toISOString(),
    ),
    levelDistribution: distribution,
  };
}
