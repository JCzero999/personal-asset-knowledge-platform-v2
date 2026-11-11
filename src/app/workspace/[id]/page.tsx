import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { Icon } from "@/components/icon";
import { ObjectActions } from "@/components/object-actions";
import { ObjectContent } from "@/components/object-content";
import { NotFoundError } from "@/domain/errors";
import { workFormats, type BusinessObject } from "@/domain/objects";
import { formatDateTime } from "@/lib/content-format";
import {
  libraryLabels,
  objectTypeLabels,
  originLabels,
  priorityLabels,
  sourceLabels,
  statusLabels,
} from "@/lib/object-labels";
import { getDb } from "@/server/db/client";
import { listObjectContent } from "@/server/services/content-service";
import { getObject } from "@/server/services/object-service";
import { requireSession, resolveAuthMode } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const formatLabels = new Map(workFormats.map((item) => [item.value, item.label]));

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-meta-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default async function ObjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const db = getDb();
  const signOutHref = resolveAuthMode() === "logto" ? "/api/logto/sign-out" : null;

  let object: BusinessObject;
  try {
    object = await getObject(db, session.sub, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const refs = await listObjectContent(db, session.sub, object.id);

  return (
    <div className="app-shell">
      <AppSidebar session={session} active="workspace" signOutHref={signOutHref} />

      <main className="workspace detail-workspace">
        <nav className="breadcrumb" aria-label="面包屑">
          <Link href="/workspace">
            <Icon name="arrow-left" size={14} />
            工作台
          </Link>
          <span aria-hidden="true">/</span>
          <span className="breadcrumb-current">{object.title}</span>
        </nav>

        <section className="panel detail-header" aria-labelledby="detail-heading">
          <div className="detail-heading">
            <span
              className={`object-type-icon detail-type-icon ${object.type}`}
              aria-hidden="true"
            >
              <Icon name={object.type === "work" ? "workflow" : "archive"} size={22} />
            </span>

            <div className="detail-title-block">
              <div className="detail-badges">
                <span className={`badge type-${object.type}`}>
                  {objectTypeLabels[object.type]}
                </span>
                <span className={`badge library-${object.library}`}>
                  {libraryLabels[object.library]}
                </span>
                {object.type === "work" ? (
                  <>
                    <span className="badge">{statusLabels[object.status]}</span>
                    <span className="badge">
                      {formatLabels.get(object.format) ?? object.format}
                    </span>
                  </>
                ) : null}
                {object.archivedAt ? (
                  <span className="badge badge-archived">已归档</span>
                ) : null}
              </div>

              <h1 className="detail-title" id="detail-heading">{object.title}</h1>

              {object.description ? (
                <p className="detail-description">{object.description}</p>
              ) : (
                <p className="detail-description detail-description-empty">
                  还没有描述，可以在「更多操作 → 编辑」里补充用途、来源或下一步计划。
                </p>
              )}
            </div>

            <div className="detail-actions">
              <ObjectActions object={object} />
            </div>
          </div>

          <dl className="detail-meta">
            <MetaItem label="类型">{objectTypeLabels[object.type]}</MetaItem>
            <MetaItem label="归属">{libraryLabels[object.library]}</MetaItem>
            <MetaItem label="状态">
              {object.type === "work" ? statusLabels[object.status] : "—"}
            </MetaItem>
            <MetaItem label="作品形态">
              {object.type === "work"
                ? formatLabels.get(object.format) ?? object.format
                : "—"}
            </MetaItem>
            <MetaItem label="优先级">{priorityLabels[object.priority]}</MetaItem>
            <MetaItem label="来源">{sourceLabels[object.source]}</MetaItem>
            <MetaItem label="来路">{originLabels[object.origin]}</MetaItem>
            <MetaItem label="分类">
              {object.categories.length > 0 ? object.categories.join("，") : "—"}
            </MetaItem>
            <MetaItem label="标签">
              {object.tags.length > 0 ? (
                <span className="detail-tags">
                  {object.tags.map((tag) => (
                    <span className="detail-tag" key={tag}>{tag}</span>
                  ))}
                </span>
              ) : "—"}
            </MetaItem>
            <MetaItem label="版本">v{object.revision}</MetaItem>
            <MetaItem label="创建">{formatDateTime(object.createdAt)}</MetaItem>
            <MetaItem label="更新">{formatDateTime(object.updatedAt)}</MetaItem>
            <MetaItem label="归档状态">
              {object.archivedAt ? `已归档 · ${formatDateTime(object.archivedAt)}` : "在用"}
            </MetaItem>
          </dl>
        </section>

        <section className="panel content-panel" aria-labelledby="content-heading">
          <div className="panel-heading">
            <div>
              <h2 id="content-heading">内容文件</h2>
              <p>原文上传后由内容库解析，解析完成就可以在「内容检索」里找到。</p>
            </div>
            <span className="meta-chip">{refs.length} 个文件</span>
          </div>

          <ObjectContent objectId={object.id} refs={refs} />
        </section>
      </main>
    </div>
  );
}
