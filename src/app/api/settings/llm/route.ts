import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { requirePermission, toActor } from "@/server/authz";
import { fromError, ok } from "@/server/http/respond";
import { getLlmSettings, updateLlmSettings } from "@/server/services/llm-settings-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 大模型供应商配置（ADR-025）。
 *
 * GET 只返回掩码与 `hasKey`，明文 API Key 永不出服务端；
 * PUT 保存后不自动重启 LightRAG——重启是独立且可回滚的 `/apply`。
 */
export async function GET() {
  const session = await getSession();
  const denied = requirePermission(session, "settings:read", "只有管理员可以查看大模型配置");
  if (denied) return denied;

  try {
    return ok(getLlmSettings(getDb()));
  } catch (error) {
    return fromError(error);
  }
}

export async function PUT(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "settings:write", "只有管理员可以修改大模型配置");
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });

    return ok(updateLlmSettings(getDb(), toActor(session!), body));
  } catch (error) {
    return fromError(error);
  }
}
