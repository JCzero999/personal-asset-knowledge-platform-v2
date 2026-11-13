import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { created, fail, fromError, ok } from "@/server/http/respond";
import { listObjectContent, uploadObjectContent } from "@/server/services/content-service";
import { requirePermission } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出对象的内容引用（含解析/同步状态）。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:read");
  if (denied) return denied;

  try {
    const { id } = await params;
    return ok(await listObjectContent(getDb(), session!.sub, id));
  } catch (error) {
    return fromError(error);
  }
}

/** multipart 上传：字段 file（必填）、role（primary | attachment）、documentName（可选）。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    const { id } = await params;
    const formData = await request.formData().catch(() => {
      throw new ValidationError("请求体必须是 multipart/form-data");
    });
    return created(await uploadObjectContent(getDb(), session!.sub, id, formData));
  } catch (error) {
    return fromError(error);
  }
}
