import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/authz";
import { fromError, ok } from "@/server/http/respond";
import { listPermissionCatalog, listRoleCatalog } from "@/server/services/user-service";
import { getSession } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 角色矩阵（只读）：权限目录随响应一起给，不单开权限接口（ADR-019）。 */
export async function GET() {
  const session = await getSession();
  const denied = requirePermission(session, "user:read");
  if (denied) return denied;

  try {
    const db = getDb();
    return ok({
      items: listRoleCatalog(db),
      permissions: listPermissionCatalog(db),
    });
  } catch (error) {
    return fromError(error);
  }
}
