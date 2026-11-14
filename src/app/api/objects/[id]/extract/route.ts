import { getDb } from "@/server/db/client";
import { readOptionalJsonBody } from "@/server/http/body";
import { created, fromError } from "@/server/http/respond";
import { extractAssetsFromWork } from "@/server/services/asset-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI 提炼：只允许外库作品的「草稿」触发。
 * 请求体固定为空对象；产物是外库资产，随后逐条自动打分（失败则保持 unscored）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    // 读一次 body，确认是合法 JSON（前端约定的 `{}`），内容不参与处理。
    await readOptionalJsonBody(request);
    const { id } = await params;
    const assets = await extractAssetsFromWork(getDb(), toActor(session!), id);
    return created({ assets });
  } catch (error) {
    return fromError(error);
  }
}
