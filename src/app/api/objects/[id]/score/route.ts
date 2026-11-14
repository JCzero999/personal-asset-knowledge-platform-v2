import { getDb } from "@/server/db/client";
import { readOptionalJsonBody } from "@/server/http/body";
import { fromError, ok } from "@/server/http/respond";
import { scoreExternalAsset } from "@/server/services/asset-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 6 维打分：只针对外库资产。
 * ≥75 同事务转内库并挂 5 维评估；60–74 待人工复核；<60 记为低价值。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    await readOptionalJsonBody(request);
    const { id } = await params;
    const asset = await scoreExternalAsset(getDb(), toActor(session!), id);
    return ok({ asset });
  } catch (error) {
    return fromError(error);
  }
}
