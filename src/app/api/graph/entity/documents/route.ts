import { fromError, ok } from "@/server/http/respond";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";
import { listEntityDocuments } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 实体相关文档：`?label=<实体名>`，按当前账号过滤，最多 10 条。
 *
 * 没有相关文档时返回空数组（不 404）——图谱里存在这个实体，只是它的来源
 * 文档不属于当前账号，属于正常情况。
 */
export async function GET(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  const label = new URL(request.url).searchParams.get("label") ?? "";

  try {
    return ok(await listEntityDocuments(getDb(), session!.sub, label));
  } catch (error) {
    return fromError(error);
  }
}
