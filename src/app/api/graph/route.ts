import { fail, fromError, ok } from "@/server/http/respond";
import { getDb } from "@/server/db/client";
import { getSession } from "@/server/session";
import { getGraphNeighborhood } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 实体邻域：label 必填，depth 1–3（默认 2）。 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  const params = new URL(request.url).searchParams;
  const label = params.get("label") ?? "";
  const rawDepth = params.get("depth");
  const depth = rawDepth === null ? undefined : Number(rawDepth);

  try {
    return ok(
      await getGraphNeighborhood(getDb(), session.sub, label, {
        ...(depth === undefined ? {} : { depth }),
      }),
    );
  } catch (error) {
    return fromError(error);
  }
}
