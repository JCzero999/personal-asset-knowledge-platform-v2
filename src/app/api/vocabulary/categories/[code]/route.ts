import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { toActor } from "@/server/authz";
import { adminGuard } from "@/server/http/guard";
import { revalidateVocabulary } from "@/server/http/revalidate";
import { fromError, ok } from "@/server/http/respond";
import { deleteCategory, updateCategory } from "@/server/services/vocabulary-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 改名 / 排序 / 停用。code 是主键，不可改。 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const session = await getSession();
  const denied = adminGuard(session, "vocabulary:category:write");
  if (denied) return denied;

  try {
    const { code } = await params;
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    const result = updateCategory(getDb(), toActor(session!), code, body);
    revalidateVocabulary();
    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}

/** 删除：被引用时 409 并带 usage；带 `?migrateTo=<code>` 时先批量迁移再删。 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const session = await getSession();
  const denied = adminGuard(session, "vocabulary:category:write");
  if (denied) return denied;

  try {
    const { code } = await params;
    const migrateTo = new URL(request.url).searchParams.get("migrateTo")?.trim() || undefined;
    const result = deleteCategory(
      getDb(),
      toActor(session!),
      code,
      migrateTo ? { migrateTo } : {},
    );
    revalidateVocabulary();
    return ok(result);
  } catch (error) {
    return fromError(error);
  }
}
