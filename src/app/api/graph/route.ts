import { fromError, ok } from "@/server/http/respond";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";
import { getGraphNeighborhood, resolveGraphMaxNodes } from "@/server/services/graph-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 实体邻域：label 必填，depth 1–3（默认 2），maxNodes 50–600（默认 150）。
 *
 * `maxNodes` 只做透传与校验（ADR-022 第 12 条）：截断由上游决定，本路由不猜。
 */
export async function GET(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const label = params.get("label") ?? "";
  const rawDepth = params.get("depth");
  const depth = rawDepth === null ? undefined : Number(rawDepth);

  try {
    const maxNodes = resolveGraphMaxNodes(params.get("maxNodes"));
    return ok(
      await getGraphNeighborhood(getDb(), session!.sub, label, {
        ...(depth === undefined ? {} : { depth }),
        maxNodes,
      }),
    );
  } catch (error) {
    return fromError(error);
  }
}
