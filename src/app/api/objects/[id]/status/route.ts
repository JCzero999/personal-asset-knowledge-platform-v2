import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { fail, fromError, ok } from "@/server/http/respond";
import { changeObjectStatus } from "@/server/services/object-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "请先登录");

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    const { id } = await params;
    return ok(await changeObjectStatus(getDb(), session.sub, id, body));
  } catch (error) {
    return fromError(error);
  }
}
