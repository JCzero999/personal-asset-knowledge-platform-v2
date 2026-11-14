import { getDb } from "@/server/db/client";
import { readOptionalJsonBody } from "@/server/http/body";
import { fromError, ok } from "@/server/http/respond";
import { practiceWork } from "@/server/services/asset-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 标记「已实践」：外库 + 已发布的作品，单事务完成
 * 「建内库资产 → 5 维评估 → 作品 practiced / 回指资产」。
 * 模型不可用时用确定性兜底，结算照常完成。
 */
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
    return ok(await practiceWork(getDb(), toActor(session!), id, body));
  } catch (error) {
    return fromError(error);
  }
}
