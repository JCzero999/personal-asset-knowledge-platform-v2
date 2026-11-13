import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/authz";
import { fail, fromError, ok } from "@/server/http/respond";
import { listAuditEvents, type AuditResult } from "@/server/services/audit-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESULTS: readonly AuditResult[] = ["ok", "error", "denied"];

/** 审计日志：游标分页，按时间与 id 倒序。 */
export async function GET(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "audit:read");
  if (denied) return denied;

  try {
    const params = new URL(request.url).searchParams;
    const result = params.get("result");
    if (result !== null && !RESULTS.includes(result as AuditResult)) {
      return fail("VALIDATION_FAILED", "result 取值非法", { field: "result" });
    }
    const limit = Number(params.get("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return fail("VALIDATION_FAILED", "limit 必须是 1~200 的整数", { field: "limit" });
    }

    return ok(
      listAuditEvents(getDb(), {
        action: params.get("action")?.trim() || undefined,
        result: (result as AuditResult | null) ?? undefined,
        actorSub: params.get("actor")?.trim() || undefined,
        from: params.get("from")?.trim() || undefined,
        to: params.get("to")?.trim() || undefined,
        limit,
        cursor: params.get("cursor")?.trim() || undefined,
      }),
    );
  } catch (error) {
    return fromError(error);
  }
}
