import { getDb } from "@/server/db/client";
import { readOptionalJsonBody } from "@/server/http/body";
import { fromError, ok } from "@/server/http/respond";
import { setAssetValueLock } from "@/server/services/usage-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手动锁定 / 解锁价值等级：锁定后自动升降级跳过该资产。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    const body = await readOptionalJsonBody(request);
    const { id } = await params;
    const object = await setAssetValueLock(getDb(), toActor(session!), id, body);
    return ok({ object });
  } catch (error) {
    return fromError(error);
  }
}
