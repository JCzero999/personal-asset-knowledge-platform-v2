import { fail, fromError, ok } from "@/server/http/respond";
import { getSession } from "@/server/session";
import { listGraphLabels } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 图谱中的实体标签列表（按 LightRAG 返回原样，已由适配器过滤非字符串）。 */
export async function GET() {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    return ok({ labels: await listGraphLabels() });
  } catch (error) {
    return fromError(error);
  }
}
