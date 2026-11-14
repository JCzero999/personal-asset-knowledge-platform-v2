import { getDb } from "@/server/db/client";
import { readOptionalJsonBody } from "@/server/http/body";
import { fromError, ok } from "@/server/http/respond";
import { recordAssetUsage } from "@/server/services/usage-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 记录一次有效调用（v2.1 §2）。1 小时内同 asset + kind + actor 只计一次，
 * 重复上报返回 `recorded: false`，前端据此决定是否刷新计数。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    const body = await readOptionalJsonBody(request);
    const { id } = await params;
    const result = await recordAssetUsage(getDb(), toActor(session!), id, body);
    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}
