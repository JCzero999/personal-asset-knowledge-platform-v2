import type { ReactNode } from "react";
import Link from "next/link";

import { AssetInsights } from "@/components/asset-insights";
import { ObjectActions } from "@/components/object-actions";
import { ObjectContent } from "@/components/object-content";
import { Icon } from "@/components/icon";
import { PreviewButton } from "@/components/preview-provider";
import { lifecycleBadges } from "@/components/lifecycle";
import { type BusinessObject } from "@/domain/objects";
import type { ContentRef } from "@/domain/content-ref";
import type { VocabularyCategory, VocabularyTag } from "@/domain/vocabulary";
import { formatDateTime } from "@/lib/content-format";
import { categoryLabel, type CategoryLabelMap } from "@/lib/category-labels";
import {
  libraryLabels,
  objectTypeLabels,
  originLabels,
  priorityLabels,
  sourceLabels,
  sourceTypeLabels,
  statusLabels,
} from "@/lib/object-labels";

/**
 * 对象详情正文：旧详情页拆出来的内容区，工作台右侧栏直接复用。
 * 不含壳、面包屑与数据获取，保持成纯展示组件。
 */

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-meta-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ObjectDetail({
  object,
  refs,
  categoryLabels,
  categories,
  tagSuggestions,
  canManageVocabulary = false,
}: {
  object: BusinessObject;
  refs: ContentRef[];
  /** 分类 code → 名称，由服务端读词表后传入（ADR-016 / ADR-023）。 */
  categoryLabels: CategoryLabelMap;
  /** 编辑弹窗用的分类词表（只取启用项由控件内部处理）。 */
  categories: VocabularyCategory[];
  /** 编辑弹窗用的标签词表。 */
  tagSuggestions: VocabularyTag[];
  canManageVocabulary?: boolean;
}) {
  const metrics = object.practiceMetrics;
  const metricsText = [
    metrics?.platform,
    typeof metrics?.views === "number" ? `浏览 ${metrics.views}` : null,
    typeof metrics?.bounceRate === "number" ? `跳出 ${metrics.bounceRate}%` : null,
    metrics?.summary,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <>
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
                <span className="badge">{statusLabels[object.status]}</span>
              ) : null}
              {object.category ? (
                <span className="badge">
                  {categoryLabel(categoryLabels, object.category)}
                </span>
              ) : null}
              {lifecycleBadges(object).map((badge) => (
                <span className={`lifecycle-badge is-${badge.tone}`} key={badge.key}>
                  {badge.label}
                </span>
              ))}
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
            <PreviewButton objectId={object.id} />
            <ObjectActions
              object={object}
              categories={categories}
              tagSuggestions={tagSuggestions}
              canManageVocabulary={canManageVocabulary}
            />
          </div>
        </div>

        <dl className="detail-meta">
          <MetaItem label="类型">{objectTypeLabels[object.type]}</MetaItem>
          <MetaItem label="归属">{libraryLabels[object.library]}</MetaItem>
          <MetaItem label="状态">
            {object.type === "work" ? statusLabels[object.status] : "—"}
          </MetaItem>
          <MetaItem label="分类">
            {object.category ? categoryLabel(categoryLabels, object.category) : "—"}
          </MetaItem>
          <MetaItem label="优先级">{priorityLabels[object.priority]}</MetaItem>
          <MetaItem label="来源">{sourceLabels[object.source]}</MetaItem>
          <MetaItem label="来路">{originLabels[object.origin]}</MetaItem>
          {object.type === "asset" && object.sourceType ? (
            <MetaItem label="资产来源">{sourceTypeLabels[object.sourceType]}</MetaItem>
          ) : null}
          {object.type === "asset" && object.originWorkId ? (
            <MetaItem label="来源作品">
              <Link className="text-button" href={`/workspace/${object.originWorkId}`} scroll={false}>
                查看原作品
              </Link>
            </MetaItem>
          ) : null}
          {object.type === "work" && object.publishedAt ? (
            <MetaItem label="发布">{formatDateTime(object.publishedAt)}</MetaItem>
          ) : null}
          {object.type === "work" && object.practicedAt ? (
            <MetaItem label="实践">{formatDateTime(object.practicedAt)}</MetaItem>
          ) : null}
          {object.type === "work" && metricsText ? (
            <MetaItem label="数据反馈">{metricsText}</MetaItem>
          ) : null}
          {object.type === "work" && object.settledAssetId ? (
            <MetaItem label="沉淀资产">
              <Link className="text-button" href={`/workspace/${object.settledAssetId}`} scroll={false}>
                查看内库资产
              </Link>
            </MetaItem>
          ) : null}
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

      {object.type === "asset" ? <AssetInsights object={object} /> : null}

      <section className="panel content-panel" aria-labelledby="content-heading">
        <div className="panel-heading">
          <div>
            <h2 id="content-heading">内容文件</h2>
            <p>原文上传后由内容库解析，解析完成就可以在「内容检索」里找到。</p>
          </div>
          <span className="meta-chip">{refs.length} 个文件</span>
        </div>

        <ObjectContent objectId={object.id} objectTitle={object.title} refs={refs} />
      </section>
    </>
  );
}
