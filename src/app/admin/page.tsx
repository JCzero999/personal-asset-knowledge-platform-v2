import { AdminActions } from "@/components/admin-actions";
import { AdminForbidden, AdminPageShell } from "@/components/admin-shell";
import { Icon, type IconName } from "@/components/icon";
import { formatDateTime } from "@/lib/content-format";
import { hasPermission } from "@/server/authz";
import { getDb } from "@/server/db/client";
import { requireSession } from "@/server/session";
import { checkServices, listRecentFailures, loadAdminOverview } from "@/server/services/admin-service";
import { listVocabulary } from "@/server/services/vocabulary-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const formatter = new Intl.NumberFormat("zh-CN");

interface QuickLink {
  href: string;
  label: string;
  note: string;
  icon: IconName;
  permission?: Parameters<typeof hasPermission>[1];
}

const quickLinks: QuickLink[] = [
  { href: "/admin/objects", label: "全部内容", note: "跨账号查看与定位", icon: "inbox" },
  { href: "/admin/users", label: "用户与账号", note: "角色、停用与归属", icon: "book", permission: "user:read" },
  { href: "/admin/system", label: "系统状态", note: "依赖服务与存储", icon: "database", permission: "system:read" },
  { href: "/admin/audit", label: "审计日志", note: "谁在什么时候做了什么", icon: "file", permission: "audit:read" },
];

export default async function AdminOverviewPage() {
  const session = await requireSession();

  if (!hasPermission(session, "system:read")) {
    return <AdminForbidden session={session} area="系统总览" permission="system:read" />;
  }

  const overview = loadAdminOverview(getDb());
  const vocabulary = listVocabulary(getDb());
  const services = await checkServices();
  const failures = listRecentFailures(getDb(), 5);

  const stats = [
    { label: "全部对象", value: overview.objects.total, icon: "inbox" as const },
    { label: "作品", value: overview.objects.works, icon: "workflow" as const },
    { label: "资产", value: overview.objects.assets, icon: "archive" as const },
    { label: "内容引用", value: overview.content.total, icon: "file" as const },
    { label: "解析待完成", value: overview.content.parsePending, icon: "clock" as const },
    {
      label: "同步失败",
      value: overview.content.syncFailed + overview.jobs.failed,
      icon: "alert" as const,
    },
  ];

  return (
    <AdminPageShell
      session={session}
      active="/admin"
      kicker="系统 · 总览"
      title="系统总览"
      description="看清内容规模、同步积压与依赖服务；改业务内容仍回工作台。"
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
      <section className="admin-stats" aria-label="内容概览">
        {stats.map((item) => (
          <div className="admin-stat" key={item.label}>
            <span className="admin-stat-icon" aria-hidden="true">
              <Icon name={item.icon} size={18} />
            </span>
            <div>
              <strong>{formatter.format(item.value)}</strong>
              <span>{item.label}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="admin-quick-links" aria-label="常用入口">
        {quickLinks
          .filter((link) => !link.permission || hasPermission(session, link.permission))
          .map((link) => (
            <a className="admin-quick-link" href={link.href} key={link.href}>
              <span className="admin-stat-icon" aria-hidden="true">
                <Icon name={link.icon} size={18} />
              </span>
              <span>
                <strong>{link.label}</strong>
                <span>{link.note}</span>
              </span>
              <Icon name="more" size={14} />
            </a>
          ))}
      </section>

      <div className="admin-grid">
        <section className="panel" aria-labelledby="admin-failures-heading">
          <div className="panel-heading">
            <div>
              <h2 id="admin-failures-heading">最近失败</h2>
              <p>同步与解析各取最近几条，按时间倒序。</p>
            </div>
            <span className="meta-chip">{failures.length} 条</span>
          </div>

          {failures.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon"><Icon name="check" size={26} /></span>
              <div className="empty-copy">
                <strong>没有失败的记录</strong>
                <p>同步队列与解析状态都正常。</p>
              </div>
            </div>
          ) : (
            <ul className="admin-failure-list">
              {failures.map((failure) => (
                <li className="admin-failure" key={`${failure.kind}-${failure.id}`}>
                  <span className={`admin-badge is-${failure.kind === "sync" ? "error" : "warn"}`}>
                    {failure.kind === "sync" ? "同步" : "解析"}
                  </span>
                  <div>
                    <strong>{failure.target}</strong>
                    <p>{failure.message}</p>
                  </div>
                  <time dateTime={failure.at}>{formatDateTime(failure.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="admin-services-heading">
          <div className="panel-heading">
            <div>
              <h2 id="admin-services-heading">依赖服务</h2>
              <p>本机三个服务各探一次，失败不影响其他功能。</p>
            </div>
            <a className="text-button" href="/admin/system#admin-system-services">详情</a>
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
      </div>
    </AdminPageShell>
  );
}
