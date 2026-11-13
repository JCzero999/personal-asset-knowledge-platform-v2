import { AdminForbidden, AdminPageShell } from "@/components/admin-shell";
import { Icon } from "@/components/icon";
import { formatDateTime } from "@/lib/content-format";
import { hasPermission } from "@/server/authz";
import { getDb } from "@/server/db/client";
import { requireSession } from "@/server/session";
import {
  AUDIT_ACTIONS,
  listAuditEvents,
  type AuditResult,
} from "@/server/services/audit-service";
import { listVocabulary } from "@/server/services/vocabulary-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resultLabels: Record<string, string> = {
  ok: "成功",
  error: "失败",
  denied: "被拒绝",
};

const resultClass: Record<string, string> = {
  ok: "is-ok",
  error: "is-error",
  denied: "is-warn",
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function buildHref(filters: Record<string, string>, cursor?: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/admin/audit?${query}` : "/admin/audit";
}

/**
 * 审计日志（ADR-019）：游标分页 + 服务端筛选。
 *
 * 筛选用普通 GET 表单，刷新即可分享链接，也不依赖客户端 JS。
 */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();

  if (!hasPermission(session, "audit:read")) {
    return <AdminForbidden session={session} area="审计日志" permission="audit:read" />;
  }

  const params = await searchParams;
  const filters = {
    action: first(params.action).trim(),
    result: first(params.result).trim(),
    actor: first(params.actor).trim(),
  };
  const result =
    filters.result === "ok" || filters.result === "error" || filters.result === "denied"
      ? (filters.result as AuditResult)
      : undefined;

  const db = getDb();
  const page = listAuditEvents(db, {
    action: filters.action || undefined,
    result,
    actorSub: filters.actor || undefined,
    limit: 50,
    cursor: first(params.cursor) || undefined,
  });
  const vocabulary = listVocabulary(db);
  const filtered = Boolean(filters.action || filters.result || filters.actor);

  return (
    <AdminPageShell
      session={session}
      active="/admin/audit"
      kicker="系统 · 审计"
      title="审计日志"
      description="谁在什么时候改了什么；被拒绝的请求也会在这里留下一条记录。"
      taxonomyCounts={{
        categories: vocabulary.categories.filter((item) => item.state === "active").length,
        tags: vocabulary.tags.length,
      }}
    >
      <form className="admin-filters" method="get" action="/admin/audit" role="search">
        <label className="admin-filter">
          <span>操作</span>
          <select name="action" defaultValue={filters.action}>
            <option value="">全部操作</option>
            {AUDIT_ACTIONS.map((action) => (
              <option value={action} key={action}>{action}</option>
            ))}
          </select>
        </label>
        <label className="admin-filter">
          <span>结果</span>
          <select name="result" defaultValue={filters.result}>
            <option value="">全部结果</option>
            <option value="ok">成功</option>
            <option value="error">失败</option>
            <option value="denied">被拒绝</option>
          </select>
        </label>
        <label className="admin-filter">
          <span>主体 sub</span>
          <input type="search" name="actor" defaultValue={filters.actor} placeholder="例如 gdv8t04dw4ca" />
        </label>
        <div className="admin-filter-actions">
          <button className="btn btn-primary" type="submit">筛选</button>
          {filtered ? <a className="btn btn-secondary" href="/admin/audit">重置</a> : null}
        </div>
      </form>

      <section className="panel admin-table-panel" aria-label="审计记录">
        {page.items.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="file" size={26} /></span>
            <div className="empty-copy">
              <strong>{filtered ? "没有匹配的记录" : "还没有审计记录"}</strong>
              <p>
                {filtered
                  ? "换个操作或结果再试，或清空筛选查看全部。"
                  : "删除、归档、改词表或账号后，这里会出现对应记录。"}
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="admin-table-scroll">
              <table className="admin-table admin-audit-table">
                <thead>
                  <tr>
                    <th scope="col">时间</th>
                    <th scope="col">操作</th>
                    <th scope="col">对象</th>
                    <th scope="col">结果</th>
                    <th scope="col">主体</th>
                    <th scope="col">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((event) => (
                    <tr key={event.id}>
                      <td data-label="时间" className="admin-time">
                        <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                      </td>
                      <td data-label="操作"><code className="admin-sub">{event.action}</code></td>
                      <td data-label="对象">
                        {event.targetType ? (
                          <span>{event.targetType}{event.targetId ? ` · ${event.targetId}` : ""}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-label="结果">
                        <span className={`admin-badge ${resultClass[event.result] ?? "is-muted"}`}>
                          {resultLabels[event.result] ?? event.result}
                        </span>
                      </td>
                      <td data-label="主体">
                        <code className="admin-sub" title={event.actorSub}>{event.actorSub}</code>
                      </td>
                      <td data-label="详情">
                        {event.detail ? (
                          <code className="admin-detail" title={event.detail}>{event.detail}</code>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {page.nextCursor ? (
              <div className="admin-pager">
                <a
                  className="btn btn-secondary"
                  href={buildHref(filters, page.nextCursor)}
                >
                  更早的记录
                </a>
              </div>
            ) : null}
          </>
        )}
      </section>

      <p className="dir-note admin-audit-note">
        拒绝记录由权限守卫尽力写入：审计表写不进去时只记服务端日志，绝不会因此放行请求。
      </p>
    </AdminPageShell>
  );
}
