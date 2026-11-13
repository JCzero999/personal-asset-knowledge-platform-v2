import { getDb } from "@/server/db/client";
import { fail, fromError, ok } from "@/server/http/respond";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";
import { syncGraph } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 把当前用户的对象内容同步进 LightRAG。
 * 返回后抽取仍在后台进行，进度以 `POST /api/graph/status` 为准。
 */
export async function POST() {
  const session = await getSession();
  const denied = requirePermission(session, "content:sync");
  if (denied) return denied;

  try {
    return ok(await syncGraph(getDb(), session!.sub));
  } catch (error) {
    return fromError(error);
  }
}
