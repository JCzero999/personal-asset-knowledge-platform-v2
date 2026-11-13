import Link from "next/link";

import { AdminForbidden, AdminPageShell } from "@/components/admin-shell";
import { Icon } from "@/components/icon";
import { formatDateTime } from "@/lib/content-format";
import { hasPermission } from "@/server/authz";
import { getDb } from "@/server/db/client";
import { requireSession } from "@/server/session";
import { listObjects } from "@/server/services/object-service";
import { listVocabulary } from "@/server/services/vocabulary-service";
import type { Library, ObjectType } from "@/domain/objects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const typeLabels: Record<string, string> = { asset: "资产", work: "作品" };
const libraryLabels: Record<string, string> = { internal: "内库", external: "外库" };
const statusLabels: Record<string, string> = {
  draft: "草稿",
  finished: "已完成",
  published: "已发布",
  practiced: "已实践",
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * 全部内容（只读）：跨账号的定位视图。
 *
 * 只给所有者与管理员用；编辑、归档、删除仍然回工作台——
 * 后台不复制第二套内容操作，避免两处状态不一致。
 */
export default async function AdminObjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();

  if (!hasPermission(session, "object:read")) {
    return <AdminForbidden session={session} area="全部内容" permission="object:read" />;
  }

  const params = await searchParams;
  const q = first(params.q).trim();
  const typeRaw = first(params.type);
  const libraryRaw = first(params.library);
  const archivedRaw = first(params.archived);

  const type = typeRaw === "asset" || typeRaw === "work" ? (typeRaw as ObjectType) : undefined;
  const library =
    libraryRaw === "internal" || libraryRaw === "external" ? (libraryRaw as Library) : undefined;
  const archivedOnly = archivedRaw === "archived";

  const db = getDb();
  const objects = await listObjects(db, {
    search: q || undefined,
    type,
    library,
    archivedOnly,
    includeArchived: archivedOnly,
    sort: "updated",
    limit: 200,
  });
  const vocabulary = listVocabulary(db);
  const categoryLabels = new Map(vocabulary.categories.map((item) => [item.code, item.label]));
  const filtered = Boolean(q || type || library || archivedOnly);

  return (
    <AdminPageShell
      session={session}
      active="/admin/objects"
      kicker="系统 · 内容"
      title="全部内容"
      description="跨账号定位内容；编辑、归档与删除仍回工作台，后台不做第二套写操作。"
      taxonomyCounts={{
        categories: vocabulary.categories.filter((item) => item.state === "active").length,
        tags: vocabulary.tags.length,
      }}
    >
      <form className="admin-filters" method="get" action="/admin/objects" role="search">
        <label className="admin-filter admin-filter-grow">
          <span>关键字</span>
          <input type="search" name="q" defaultValue={q} placeholder="标题或描述" />
        </label>
        <label className="admin-filter">
          <span>类型</span>
          <select name="type" defaultValue={typeRaw}>
            <option value="">全部类型</option>
            <option value="asset">资产</option>
            <option value="work">作品</option>
          </select>
        </label>
        <label className="admin-filter">
          <span>库别</span>
          <select name="library" defaultValue={libraryRaw}>
            <option value="">全部库别</option>
            <option value="internal">内库</option>
            <option value="external">外库</option>
          </select>
        </label>
        <label className="admin-filter">
          <span>归档</span>
          <select name="archived" defaultValue={archivedRaw}>
            <option value="">使用中</option>
            <option value="archived">仅已归档</option>
          </select>
        </label>
        <div className="admin-filter-actions">
          <button className="btn btn-primary" type="submit">筛选</button>
          {filtered ? <a className="btn btn-secondary" href="/admin/objects">重置</a> : null}
        </div>
      </form>

      <section className="panel admin-table-panel" aria-label="内容列表">
        {objects.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Icon name="inbox" size={26} /></span>
            <div className="empty-copy">
              <strong>{filtered ? "没有匹配的内容" : "还没有内容"}</strong>
              <p>{filtered ? "换个关键字，或放宽类型与库别。" : "在工作台新建内容后会出现在这里。"}</p>
            </div>
          </div>
        ) : (
          <>
            <div className="admin-table-scroll">
              <table className="admin-table admin-objects-table">
                <thead>
                  <tr>
                    <th scope="col">标题</th>
                    <th scope="col">类型</th>
                    <th scope="col">形态</th>
                    <th scope="col">库别</th>
                    <th scope="col">状态</th>
                    <th scope="col">归属</th>
                    <th scope="col">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {objects.map((object) => {
                    const mine = object.ownerSub === session.sub;
                    return (
                      <tr key={object.id}>
                        <td data-label="标题">
                          <div className="admin-object-title">
                            {mine ? (
                              <Link href={`/workspace/${object.id}`}>{object.title}</Link>
                            ) : (
                              <span>{object.title}</span>
                            )}
                            {object.archivedAt ? (
                              <span className="admin-badge is-muted">已归档</span>
                            ) : null}
                          </div>
                        </td>
                        <td data-label="类型">{typeLabels[object.type] ?? object.type}</td>
                        <td data-label="分类">
                          {object.category
                            ? categoryLabels.get(object.category) ?? object.category
                            : "—"}
                        </td>
                        <td data-label="库别">{libraryLabels[object.library] ?? object.library}</td>
                        <td data-label="状态">
                          {object.type === "work"
                            ? statusLabels[object.status] ?? object.status
                            : "—"}
                        </td>
                        <td data-label="归属">
                          <code className="admin-sub" title={object.ownerSub}>{object.ownerSub}</code>
                        </td>
                        <td data-label="更新时间" className="admin-time">
                          {formatDateTime(object.updatedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {objects.length >= 200 ? (
              <p className="admin-pager-note">最多显示 200 条，用关键字可以缩小范围。</p>
            ) : null}
          </>
        )}
      </section>
    </AdminPageShell>
  );
}
