import { and, desc, eq, gte, lt, lte, or, type SQL } from "drizzle-orm";

import { auditEvents, type NewAuditEventRow } from "../db/schema";
import { ulid } from "../db/id";
import type { AppDatabase } from "../db/client";
import type { ActorContext } from "../authz";

/**
 * 审计（ADR-019 第 8 条）。
 *
 * 写入语义：与业务写**同一事务**，审计失败则业务回滚（错误码 `AUDIT_FAILED`）。
 * 唯一例外是 403 的 `denied` 记录：没有业务写可回滚，由守卫独立写入，
 * 失败只记应用日志、绝不放行请求。
 */

type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

/** 业务事务句柄与顶层连接都满足这个形状；两边都是同步 drizzle 句柄。 */
export type AuditDb = AppDatabase | Tx;

export type AuditResult = "ok" | "error" | "denied";

export interface AuditInput {
  actor: Pick<ActorContext, "sub" | "userId">;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  result?: AuditResult;
  createdAt?: string;
}

export function writeAudit(db: AuditDb, input: AuditInput): void {
  const row: NewAuditEventRow = {
    id: ulid(),
    actorSub: input.actor.sub,
    actorUserId: input.actor.userId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    detail: input.detail === undefined ? null : JSON.stringify(input.detail),
    result: input.result ?? "ok",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  (db as AppDatabase).insert(auditEvents).values(row).run();
}

/**
 * 403 拒绝记录：独立写入，失败只落应用日志。
 * 审计写不进去不能成为放行请求的理由。
 */
export function recordDeniedAudit(
  db: AuditDb,
  actor: { sub: string; userId: string | null },
  permission: string,
  target: { type?: string; id?: string } = {},
): void {
  try {
    writeAudit(db, {
      actor,
      action: "authz.denied",
      targetType: target.type ?? "permission",
      targetId: target.id ?? permission,
      detail: { permission },
      result: "denied",
    });
  } catch (error) {
    console.error("[audit] 写拒绝记录失败（请求仍拒绝）", error);
  }
}

export interface AuditQuery {
  action?: string;
  result?: AuditResult;
  actorSub?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditEvent {
  id: string;
  actorSub: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
  result: string;
  createdAt: string;
}

export interface AuditPage {
  items: AuditEvent[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(event: AuditEvent): string {
  return Buffer.from(`${event.createdAt}|${event.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * 游标分页（不用 offset）：边写边翻页时不会重复或漏行。
 * 排序固定为 `created_at DESC, id DESC`。
 */
export function listAuditEvents(db: AppDatabase, query: AuditQuery = {}): AuditPage {
  const filters: SQL[] = [];

  if (query.action) filters.push(eq(auditEvents.action, query.action));
  if (query.result) filters.push(eq(auditEvents.result, query.result));
  if (query.actorSub) filters.push(eq(auditEvents.actorSub, query.actorSub));
  if (query.from) filters.push(gte(auditEvents.createdAt, query.from));
  if (query.to) filters.push(lte(auditEvents.createdAt, query.to));

  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (decoded) {
      const pageFilter = or(
        lt(auditEvents.createdAt, decoded.createdAt),
        and(eq(auditEvents.createdAt, decoded.createdAt), lt(auditEvents.id, decoded.id)),
      );
      if (pageFilter) filters.push(pageFilter);
    }
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = db
    .select()
    .from(auditEvents)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit + 1)
    .all();

  const items = rows.slice(0, limit);
  const last = items.at(-1);

  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

/** 词表 / 用户等「允许的动作」清单，供审计筛选下拉使用。 */
export const AUDIT_ACTIONS = [
  "object.delete",
  "object.archive",
  "object.unarchive",
  "object.library.change",
  "object.ai.score",
  "object.ai.review",
  "object.practice",
  "object.use",
  "object.value.assess",
  "object.value.adjust",
  "object.value.lock",
  "value.fallback",
  "value.snapshot_failed",
  "value.reassess_failed",
  "vocabulary.category.create",
  "vocabulary.category.update",
  "vocabulary.category.delete",
  "vocabulary.tag.create",
  "vocabulary.tag.update",
  "vocabulary.tag.delete",
  "vocabulary.tag.merge",
  "content.sync.run",
  "content.parse.run",
  "user.roles.update",
  "user.state.update",
  "user.sub.update",
  "user.bootstrap",
  "settings.llm.update",
  "settings.llm.apply",
  "authz.denied",
] as const;
