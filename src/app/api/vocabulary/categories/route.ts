import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { hasPermission, toActor } from "@/server/authz";
import { inlineVocabularyGuard } from "@/server/http/guard";
import { revalidateVocabulary } from "@/server/http/revalidate";
import { created, fromError, ok } from "@/server/http/respond";
import { createCategory } from "@/server/services/vocabulary-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 新增分类（ADR-023 第 7、8 条）。
 *
 * - `object:write` 即可调用（内联创建），不必有词表管理权限；
 * - `reuseExisting: true` 且命中同名启用项 → 200 返回已有项，否则 409 `CATEGORY_EXISTS`；
 * - 命中已停用项 → 409 `CATEGORY_ARCHIVED`，不自动复活。
 */
export async function POST(request: Request) {
  const session = await getSession();
  const denied = inlineVocabularyGuard(session, "vocabulary:category:write");
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    const payload =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : body;
    const source = hasPermission(session, "vocabulary:category:write") ? "admin" : "inline";
    const result = createCategory(getDb(), toActor(session!), { ...(payload as object), source });
    revalidateVocabulary();
    return result.created ? created(result.category) : ok(result.category);
  } catch (error) {
    return fromError(error);
  }
}
