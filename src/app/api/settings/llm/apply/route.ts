import { getDb } from "@/server/db/client";
import { requirePermission, toActor } from "@/server/authz";
import { fromError, ok } from "@/server/http/respond";
import { applyLlmSettings } from "@/server/services/llm-settings-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 应用并重启 LightRAG（ADR-025）。
 *
 * 写 `infra/lightrag/.env`（先备份）→ 只重启 lightrag-server → 轮询 /health 最多 60s。
 * 失败时自动回滚 .env 并重启回原配置，返回带 `rolledBack` 的错误。
 */
export async function POST() {
  const session = await getSession();
  const denied = requirePermission(session, "settings:write", "只有管理员可以应用大模型配置");
  if (denied) return denied;

  try {
    return ok(await applyLlmSettings(getDb(), toActor(session!)));
  } catch (error) {
    return fromError(error);
  }
}
