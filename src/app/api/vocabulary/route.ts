import { getDb } from "@/server/db/client";
import { fromError, ok } from "@/server/http/respond";
import { listVocabulary } from "@/server/services/vocabulary-service";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 词表唯一读取入口（ADR-016 第 5 条 / ADR-023 第 7 条）：分类 + 标签，含使用次数。
 * 前端所有「分类 / 标签」下拉与 chips 都从这里取，不再读代码常量。
 */
export async function GET() {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  try {
    return ok(listVocabulary(getDb()));
  } catch (error) {
    return fromError(error);
  }
}
