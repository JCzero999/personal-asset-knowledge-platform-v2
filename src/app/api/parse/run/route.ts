import { getDb } from "@/server/db/client";
import { fail, fromError, ok } from "@/server/http/respond";
import { requirePermission, toActor } from "@/server/authz";
import { writeAudit } from "@/server/services/audit-service";
import { getSession } from "@/server/session";
import { pollParsingOnce } from "@/server/services/parse-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手动推进一轮解析状态轮询；后台 worker 会按间隔自动跑同一段逻辑。 */
export async function POST() {
  const session = await getSession();
  const denied = requirePermission(session, "content:parse");
  if (denied) return denied;

  const db = getDb();

  try {
    const stats = await pollParsingOnce(db, { limit: 50 });
    writeAudit(db, {
      actor: toActor(session!),
      action: "content.parse.run",
      targetType: "system",
      detail: stats,
    });
    return ok(stats);
  } catch (error) {
    try {
      writeAudit(db, {
        actor: toActor(session!),
        action: "content.parse.run",
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
