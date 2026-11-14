import { getDb } from "@/server/db/client";
import { fromError, ok } from "@/server/http/respond";
import { getValueMetrics } from "@/server/services/value-metrics-service";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 价值兜底与分布指标（v2.1 §5）。
 *
 * 不新增权限项：这些数字只给后台看，沿用 `settings:read`（owner/admin）。
 */
export async function GET() {
  const session = await getSession();
  const denied = requirePermission(session, "settings:read");
  if (denied) return denied;

  try {
    return ok(getValueMetrics(getDb()));
  } catch (error) {
    return fromError(error);
  }
}
