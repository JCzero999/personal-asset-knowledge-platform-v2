import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { created, fail, fromError } from "@/server/http/respond";
import { uploadObjectContent } from "@/server/services/content-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** multipart 上传：字段 file（必填）、role（primary | attachment）、documentName（可选）。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    const { id } = await params;
    const formData = await request.formData().catch(() => {
      throw new ValidationError("请求体必须是 multipart/form-data");
    });
    return created(await uploadObjectContent(getDb(), session.sub, id, formData));
  } catch (error) {
    return fromError(error);
  }
}
