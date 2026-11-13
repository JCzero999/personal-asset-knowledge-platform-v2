import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/authz";
import { fromError, ok } from "@/server/http/respond";
import { testLlmConnection } from "@/server/services/llm-settings-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 测试连接：向供应商发最小请求（max_tokens 8）。
 *
 * 请求体可只带要覆盖的字段（例如刚输入、尚未保存的 apiKey）；
 * 缺省字段沿用已保存配置。失败原因是业务结果，仍以 200 返回。
 */
export async function POST(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "settings:write", "只有管理员可以测试大模型连接");
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => ({}));
    return ok(await testLlmConnection(getDb(), body));
  } catch (error) {
    return fromError(error);
  }
}
