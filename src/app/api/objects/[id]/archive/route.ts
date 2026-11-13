import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { fail, fromError, ok } from "@/server/http/respond";
import { setObjectArchived } from "@/server/services/object-service";
import { requirePermission, toActor } from "@/server/authz";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "object:write");
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    const { id } = await params;
    return ok(await setObjectArchived(getDb(), toActor(session!), id, body));
  } catch (error) {
    return fromError(error);
  }
}
