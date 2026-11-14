import { getDb } from "@/server/db/client";
import { readOptionalJsonBody } from "@/server/http/body";
import { fromError, ok } from "@/server/http/respond";
import { assessAssetValue } from "@/server/services/asset-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 内库资产重评：只更新 `value_*` 三列。
 * 模型失败直接报错，不做静默降级（否则好资产会被悄悄判成 C）。
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
    const asset = await assessAssetValue(getDb(), toActor(session!), id);
    return ok({ asset });
  } catch (error) {
    return fromError(error);
  }
}
