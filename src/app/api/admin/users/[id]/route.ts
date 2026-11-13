import { ValidationError } from "@/domain/errors";
import { getDb } from "@/server/db/client";
import { requirePermission, toActor } from "@/server/authz";
import { fromError, ok } from "@/server/http/respond";
import { updateUser } from "@/server/services/user-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 改角色 / 停用用户。最后一个 active owner 被移除或停用时返回
 * 422 `LAST_OWNER`；`sub` 仅所有者可改。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  const denied = requirePermission(session, "user:write", "只有所有者可以修改账号");
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => {
      throw new ValidationError("请求体不是合法 JSON");
    });
    const { id } = await params;
    return ok(updateUser(getDb(), toActor(session!), id, body));
  } catch (error) {
    return fromError(error);
  }
}
