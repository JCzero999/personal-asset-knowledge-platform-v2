import { AdminForbidden, AdminPageShell } from "@/components/admin-shell";
import { Icon } from "@/components/icon";
import { hasPermission } from "@/server/authz";
import { getDb } from "@/server/db/client";
import { requireSession } from "@/server/session";
import { listPermissionCatalog, listRoleCatalog } from "@/server/services/user-service";
import { listVocabulary } from "@/server/services/vocabulary-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 角色 × 权限矩阵（只读）。
 *
 * v1 的角色是固定四档（ADR-019），矩阵直接读库展示；
 * 分配角色在「用户」页完成，这里只负责让权限边界一眼可见。
 */
export default async function AdminRolesPage() {
  const session = await requireSession();

  if (!hasPermission(session, "user:read")) {
    return <AdminForbidden session={session} area="角色与权限" permission="user:read" />;
  }

  const db = getDb();
  const roles = listRoleCatalog(db);
  const permissions = listPermissionCatalog(db);
  const vocabulary = listVocabulary(db);

  const granted = new Map(roles.map((role) => [role.key, new Set(role.permissions)]));
  const groups = new Map<string, typeof permissions>();
  for (const permission of permissions) {
    const list = groups.get(permission.groupKey) ?? [];
    list.push(permission);
    groups.set(permission.groupKey, list);
  }

  return (
    <AdminPageShell
      session={session}
      active="/admin/roles"
      kicker="系统 · 角色"
      title="角色与权限"
      description="四个固定角色与十三项权限的对应关系；分配角色在「用户」页完成。"
      taxonomyCounts={{
        categories: vocabulary.categories.filter((item) => item.state === "active").length,
        tags: vocabulary.tags.length,
      }}
    >
      <section className="panel admin-note-panel" role="note">
        <Icon name="alert" size={16} />
        <p>
          角色是内置的四档，本页只读。需要让某个账号拥有更多权限时，
          在「用户」里给它换一个角色；权限点本身由开发者维护，不做运行期增删。
        </p>
      </section>

      <section className="panel admin-table-panel" aria-label="角色权限矩阵">
        <div className="admin-table-scroll">
          <table className="admin-table admin-matrix">
            <thead>
              <tr>
                <th scope="col">权限</th>
                {roles.map((role) => (
                  <th scope="col" key={role.key}>
                    {role.label}
                    <span className="admin-matrix-count">{role.permissions.length}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...groups.entries()].map(([groupKey, items]) => (
                <FragmentGroup
                  key={groupKey}
                  groupKey={groupKey}
                  items={items}
                  roles={roles}
                  granted={granted}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AdminPageShell>
  );
}

function FragmentGroup({
  groupKey,
  items,
  roles,
  granted,
}: {
  groupKey: string;
  items: Array<{ key: string; label: string }>;
  roles: Array<{ key: string; label: string }>;
  granted: Map<string, Set<string>>;
}) {
  return (
    <>
      <tr className="admin-matrix-group">
        <th scope="rowgroup" colSpan={roles.length + 1}>{groupKey}</th>
      </tr>
      {items.map((permission) => (
        <tr key={permission.key}>
          <th scope="row">
            <strong>{permission.label}</strong>
            <code className="admin-perm-key">{permission.key}</code>
          </th>
          {roles.map((role) => (
            <td key={role.key}>
              {granted.get(role.key)?.has(permission.key) ? (
                <span className="admin-matrix-yes" aria-label="有">
                  <Icon name="check" size={15} />
                </span>
              ) : (
                <span className="admin-matrix-no" aria-label="无">—</span>
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
