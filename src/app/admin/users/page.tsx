import { AdminForbidden, AdminPageShell } from "@/components/admin-shell";
import { AdminUsers } from "@/components/admin-users";
import { hasPermission } from "@/server/authz";
import { getDb } from "@/server/db/client";
import { requireSession } from "@/server/session";
import { listRoleCatalog, listUsers } from "@/server/services/user-service";
import { listVocabulary } from "@/server/services/vocabulary-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const session = await requireSession();

  if (!hasPermission(session, "user:read")) {
    return <AdminForbidden session={session} area="账号管理" permission="user:read" />;
  }

  const db = getDb();
  const users = listUsers(db);
  const roles = listRoleCatalog(db);
  const vocabulary = listVocabulary(db);

  return (
    <AdminPageShell
      session={session}
      active="/admin/users"
      kicker="系统 · 账号"
      title="用户与账号"
      description="改角色、停用或启用账号；名称与邮箱在下次登录时自动刷新。"
      taxonomyCounts={{
        categories: vocabulary.categories.filter((item) => item.state === "active").length,
        tags: vocabulary.tags.length,
      }}
    >
      <AdminUsers
        users={users}
        roles={roles}
        canWrite={hasPermission(session, "user:write")}
        currentUserId={session.userId}
      />
    </AdminPageShell>
  );
}
