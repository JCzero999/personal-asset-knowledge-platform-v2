import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { hasPermission, toActor } from "@/server/authz";
import { inlineVocabularyGuard } from "@/server/http/guard";
import { revalidateVocabulary } from "@/server/http/revalidate";
import { created, fromError } from "@/server/http/respond";
import { createTag } from "@/server/services/vocabulary-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 新增标签（ADR-023 第 8 条）：拥有 object:write 的编辑者即可内联创建；
 * 按归一化键命中即复用已有标签，不产生重复记录。
 */
export async function POST(request: Request) {
  const session = await getSession();
  const denied = inlineVocabularyGuard(session, "vocabulary:tag:write");
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    const payload =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : body;
    const source = hasPermission(session, "vocabulary:tag:write") ? "admin" : "inline";
    const result = createTag(getDb(), toActor(session!), { ...(payload as object), source });
    revalidateVocabulary();
    return created(result);
  } catch (error) {
    return fromError(error);
  }
}
