import { getDb } from "@/server/db/client";
import { readOptionalJsonBody } from "@/server/http/body";
import { fromError, ok } from "@/server/http/respond";
import { reassessAssets } from "@/server/services/reassess-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 批量重评（v2.1 §5）：body 传 `{ids}` 或 `{filter:{level?,source?}}`，
 * 逐条重跑模型；一条失败不影响其余条，返回 `{ok, failed}`。
 */
export async function POST(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    const body = await readOptionalJsonBody(request);
    return ok(await reassessAssets(getDb(), toActor(session!), body));
  } catch (error) {
    return fromError(error);
  }
}
