import { fail, fromError, ok } from "@/server/http/respond";
import { getDb } from "@/server/db/client";
import { getSession } from "@/server/session";
import { listGraphLabels } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 图谱中的实体标签列表；只返回当前账号内容涉及的实体（ADR-011）。 */
export async function GET() {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    return ok({ labels: await listGraphLabels(getDb(), session.sub) });
  } catch (error) {
    return fromError(error);
  }
}
