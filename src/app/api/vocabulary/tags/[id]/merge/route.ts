import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { toActor } from "@/server/authz";
import { adminGuard } from "@/server/http/guard";
import { revalidateVocabulary } from "@/server/http/revalidate";
import { fromError, ok } from "@/server/http/respond";
import { mergeTag } from "@/server/services/vocabulary-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 合并：把源标签的全部引用改到目标标签（已含则去重），再删源标签。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = adminGuard(session, "vocabulary:tag:write");
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    const result = mergeTag(getDb(), toActor(session!), id, body);
    revalidateVocabulary();
    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}
