import { fail, fromError, ok } from "@/server/http/respond";
import { getSession } from "@/server/session";
import { graphStatus } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 构图进度：LightRAG 里各文档的抽取状态汇总。 */
export async function GET() {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    return ok(await graphStatus());
  } catch (error) {
    return fromError(error);
  }
}
