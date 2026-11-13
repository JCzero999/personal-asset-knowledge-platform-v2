import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/authz";
import { fail, fromError, ok } from "@/server/http/respond";
import { listUsers } from "@/server/services/user-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 后台账号列表：显示名、sub、邮箱、角色、状态、对象数、最近登录。 */
export async function GET(request: Request) {
  const session = await getSession();
  const denied = requirePermission(session, "user:read");
  if (denied) return denied;

  try {
    const params = new URL(request.url).searchParams;
    const state = params.get("state");
    if (state !== null && state !== "active" && state !== "disabled") {
      return fail("VALIDATION_FAILED", "state 取值非法", { field: "state" });
    }

    return ok({
      items: listUsers(getDb(), {
        search: params.get("query")?.trim() || undefined,
        state: state ?? undefined,
      }),
    });
  } catch (error) {
    return fromError(error);
  }
}
