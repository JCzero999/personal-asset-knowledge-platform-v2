import { getDb } from "@/server/db/client";
import { fail, fromError, ok } from "@/server/http/respond";
import { requirePermission, toActor } from "@/server/authz";
import { writeAudit } from "@/server/services/audit-service";
import { getSession } from "@/server/session";
import { runSyncOnce } from "@/server/services/sync-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手动触发一轮 outbox 投递；后台 worker 会按间隔自动跑同一段逻辑。 */
export async function POST() {
  const session = await getSession();
  const denied = requirePermission(session, "content:sync");
  if (denied) return denied;

  const db = getDb();

  try {
    const stats = await runSyncOnce(db, { limit: 20 });
    // 维护动作也落审计：谁在什么时候手动催了一轮（ADR-019 第三层）。
    writeAudit(db, {
      actor: toActor(session!),
      action: "content.sync.run",
      targetType: "system",
      detail: stats,
    });
    return ok(stats);
  } catch (error) {
    try {
      writeAudit(db, {
        actor: toActor(session!),
        action: "content.sync.run",
        targetType: "system",
        result: "error",
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
    } catch (auditError) {
      console.error("[audit] 维护动作审计写入失败", auditError);
    }
    return fromError(error);
  }
}
