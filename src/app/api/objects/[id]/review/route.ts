import { getDb } from "@/server/db/client";
import { readJsonBody } from "@/server/http/body";
import { fromError, ok } from "@/server/http/respond";
import { reviewAsset } from "@/server/services/asset-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 人工复核：只有「待人工复核」的资产可以调用。
 * approve → 转内库并完成 5 维评估；reject → 记为低价值，留在外库。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const { id } = await params;
    const asset = await reviewAsset(getDb(), toActor(session!), id, body);
    return ok({ asset });
  } catch (error) {
    return fromError(error);
  }
}
