import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { toActor } from "@/server/authz";
import { adminGuard } from "@/server/http/guard";
import { revalidateVocabulary } from "@/server/http/revalidate";
import { fromError, ok } from "@/server/http/respond";
import { deleteTag, updateTag } from "@/server/services/vocabulary-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 改名：只改 label / normalized，object_tags 存的是 id，全站立即生效。 */
export async function PATCH(
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
    const result = updateTag(getDb(), toActor(session!), id, body);
    revalidateVocabulary();
    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}

/** 删除：默认被引用即 409；`{ removeFromObjects: true }` 才连同对象上的标签一起移除。 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = adminGuard(session, "vocabulary:tag:write");
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const removeFromObjects =
      typeof body === "object" && body !== null && (body as { removeFromObjects?: unknown }).removeFromObjects === true;
    const result = deleteTag(getDb(), toActor(session!), id, { removeFromObjects });
    revalidateVocabulary();
    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}
