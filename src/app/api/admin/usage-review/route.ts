import { getDb } from "@/server/db/client";
import { readOptionalJsonBody } from "@/server/http/body";
import { fromError, ok } from "@/server/http/respond";
import { runUsageReview } from "@/server/services/usage-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 手动触发一次使用度复核（v2.1 §2）：遍历内库资产，按近 30 天调用与闲置
 * 天数自动升降级。
 *
 * 权限沿用 `settings:write`：复核会批量改价值等级，属于系统级操作；
 * 不新开权限项，避免只为一次手动触发再加一条迁移。
 */
export async function POST(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "settings:write");
  if (denied) return denied;

  try {
    await readOptionalJsonBody(request);
    return ok(await runUsageReview(getDb(), toActor(session!)));
  } catch (error) {
    return fromError(error);
  }
}
