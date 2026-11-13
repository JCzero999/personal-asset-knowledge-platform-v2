import { AdminActions } from "@/components/admin-actions";
import { AdminForbidden, AdminPageShell } from "@/components/admin-shell";
import { Icon } from "@/components/icon";
import { formatDateTime, formatFileSize } from "@/lib/content-format";
import { hasPermission } from "@/server/authz";
import { getDb } from "@/server/db/client";
import { requireSession } from "@/server/session";
import { checkServices, loadAdminOverview } from "@/server/services/admin-service";
import { listVocabulary } from "@/server/services/vocabulary-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const formatter = new Intl.NumberFormat("zh-CN");

export default async function AdminSystemPage() {
  const session = await requireSession();

  if (!hasPermission(session, "system:read")) {
    return <AdminForbidden session={session} area="系统状态" permission="system:read" />;
  }

  const overview = loadAdminOverview(getDb());
  const vocabulary = listVocabulary(getDb());
  const services = await checkServices();

  return (
    <AdminPageShell
      session={session}
      active="/admin/system"
      kicker="系统 · 运维"
      title="系统状态"
      description="依赖服务、存储与队列的只读状态；改业务内容仍回工作台。"
      taxonomyCounts={{
        categories: vocabulary.categories.filter((item) => item.state === "active").length,
        tags: vocabulary.tags.length,
      }}
      actions={
        <AdminActions
          canSync={hasPermission(session, "content:sync")}
          canParse={hasPermission(session, "content:parse")}
        />
      }
    >
      <div className="admin-grid">
        {/* 旧链接 /admin#admin-services 仍应落在有意义的位置。 */}
        <section
          className="panel"
          id="admin-services"
          aria-labelledby="admin-system-services"
        >
          <div className="panel-heading">
            <div>
              <h2 id="admin-system-services">依赖服务</h2>
              <p>本机三个服务各探一次，失败不影响其他功能。</p>
            </div>
          </div>
          <ul className="admin-service-list">
            {services.map((service) => (
              <li className="admin-service" key={service.name}>
                <span
                  className={`admin-dot${service.ok ? " is-ok" : " is-down"}`}
                  aria-hidden="true"
                />
                <strong>{service.name}</strong>
                <span className="admin-service-detail">
                  {service.ok ? "在线" : "不可用"} · {service.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel" id="admin-storage" aria-labelledby="admin-storage-heading">
          <div className="panel-heading">
            <div>
              <h2 id="admin-storage-heading">存储与队列</h2>
              <p>业务数据在本机 SQLite，原文在 RAGFlow。</p>
            </div>
          </div>
          <dl className="admin-kv">
            <div>
              <dt>数据库文件</dt>
              <dd className="admin-path" title={overview.storage.path}>
                {overview.storage.path}
              </dd>
            </div>
            <div>
              <dt>文件大小</dt>
              <dd>
                {overview.storage.bytes === null
                  ? "尚未创建"
                  : formatFileSize(overview.storage.bytes)}
              </dd>
            </div>
            <div>
              <dt>已归档 / 已删除</dt>
              <dd>
                {formatter.format(overview.objects.archived)} /{" "}
                {formatter.format(overview.objects.deleted)}
              </dd>
            </div>
            <div>
              <dt>同步任务</dt>
              <dd>
                待处理 {overview.jobs.pending} · 进行中 {overview.jobs.running} ·
                完成 {overview.jobs.done} · 失败 {overview.jobs.failed}
              </dd>
            </div>
            <div>
              <dt>解析失败</dt>
              <dd>{formatter.format(overview.content.parseFailed)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="panel" id="admin-owners" aria-labelledby="admin-owners-heading">
        <div className="panel-heading">
          <div>
            <h2 id="admin-owners-heading">用户与归属</h2>
            <p>按内容归属统计；角色与停用在「用户」页维护。</p>
          </div>
          <div className="panel-heading-actions">
            <span className="meta-chip">{overview.owners.length} 个账号</span>
            {hasPermission(session, "user:read") ? (
              <a className="text-button" href="/admin/users">管理用户</a>
            ) : null}
          </div>
        </div>

        {overview.owners.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="inbox" size={26} /></span>
            <div className="empty-copy">
              <strong>还没有任何内容</strong>
              <p>在工作台新建一条资产或作品后，这里会出现归属统计。</p>
            </div>
          </div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">用户标识（Logto sub）</th>
                <th scope="col">内容</th>
                <th scope="col">作品</th>
                <th scope="col">最近更新</th>
              </tr>
            </thead>
            <tbody>
              {overview.owners.map((owner) => (
                <tr key={owner.ownerSub}>
                  <td>
                    <code className="admin-sub" title={owner.ownerSub}>
                      {owner.ownerSub}
                    </code>
                  </td>
                  <td>{formatter.format(owner.objects)}</td>
                  <td>{formatter.format(owner.works)}</td>
                  <td>{owner.lastUpdatedAt ? formatDateTime(owner.lastUpdatedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AdminPageShell>
  );
}
