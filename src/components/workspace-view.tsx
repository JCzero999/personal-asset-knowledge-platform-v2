import Link from "next/link";

import { type BusinessObject, type WorkStatus } from "@/domain/objects";
import type { ContentRef } from "@/domain/content-ref";
import { buildCategoryLabelMap } from "@/lib/category-labels";
import { statusLabels } from "@/lib/object-labels";
import {
  activeFilterChips,
  buildWorkspaceHref,
  hasActiveFilters,
  LIST_LIMIT,
  sortLabels,
  type WorkspaceFilters,
} from "@/lib/workspace-filters";
import { hasPermission } from "@/server/authz";
import type { Session } from "@/server/ports/session";
import type { VocabularySnapshot } from "@/domain/vocabulary";
import { CreateObjectButton } from "./create-object-dialog";
import { WorkspaceDirectory, type WorkspaceCounts } from "./directory";
import { Icon, type IconName } from "./icon";
import { NavRail } from "./nav-rail";
import { ObjectDetail } from "./object-detail";
import { ObjectFilters } from "./object-filters";
import { RecordList } from "./record-list";

/**
 * 工作台三列布局：图标栏 → 目录 → 列表，右侧是概览或选中内容的详情。
 * 列表与详情同屏，点一条看一条，不再整页跳走（对齐旧项目的工作区结构）。
 */

const stages: Array<{
  key: WorkStatus;
  title: string;
  description: string;
  icon: IconName;
}> = [
  { key: "draft", title: "草稿", description: "记下想法，随时补充", icon: "file" },
  { key: "finished", title: "已完成", description: "内容成形，可以交付", icon: "check" },
  { key: "published", title: "已发布", description: "发出去，触达读者", icon: "book" },
  { key: "practiced", title: "已实践", description: "用起来，收集反馈", icon: "sparkles" },
];

function greeting(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function CompositionRow({
  label,
  count,
  percent,
  soft = false,
}: {
  label: string;
  count: number;
  percent: number;
  soft?: boolean;
}) {
  return (
    <div className="composition-row">
      <div className="composition-row-head">
        <span>{label}</span>
        <strong>{count}</strong>
      </div>
      <div className="composition-bar" aria-hidden="true">
        <span
          className={`composition-fill${soft ? " soft" : ""}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function Overview({
  session,
  allObjects,
  counts,
  now,
  vocabulary,
}: {
  session: Session;
  allObjects: BusinessObject[];
  counts: WorkspaceCounts;
  now: Date;
  vocabulary: VocabularySnapshot;
}) {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const weeklyCount = allObjects.filter(
    (object) => Date.parse(object.createdAt) >= weekAgo,
  ).length;
  const total = allObjects.length;
  const percentOf = (count: number) => (total === 0 ? 0 : Math.round((count / total) * 100));

  const overview = [
    { label: "全部内容", value: counts.total, icon: "inbox" as IconName },
    { label: "资产", value: counts.assets, icon: "archive" as IconName },
    { label: "作品", value: counts.works, icon: "workflow" as IconName },
    { label: "本周新增", value: weeklyCount, icon: "clock" as IconName },
  ];

  const todayLabel = `${now.getMonth() + 1}月${now.getDate()}日 · ${now.toLocaleDateString("zh-CN", { weekday: "long" })}`;

  return (
    <div className="workspace-overview">
      <header className="workspace-header overview-header">
        <div className="workspace-greeting">
          <p className="workspace-date">{todayLabel}</p>
          <h1>{greeting(now.getHours())}，{session.name}</h1>
          <p className="workspace-subtitle">
            把收集到的资料沉淀成资产，把想法推进成作品；从左侧目录进入，或直接选一条内容。
          </p>
        </div>
        <div className="header-actions">
          <CreateObjectButton label="新建" vocabulary={vocabulary} canManageVocabulary={hasPermission(session, "vocabulary:category:write")} />
        </div>
      </header>

      <section className="overview" aria-label="内容概览">
        {overview.map((item) => (
          <div className="overview-item" key={item.label}>
            <span className="overview-icon"><Icon name={item.icon} size={19} /></span>
            <div className="overview-copy">
              <strong>{item.value}</strong>
              <span>{item.label}</span>
            </div>
          </div>
        ))}
      </section>

      <div className="dashboard-grid overview-grid">
        <section className="panel track-panel" id="track" aria-labelledby="track-heading">
          <div className="panel-heading">
            <div>
              <h2 id="track-heading">作品进程</h2>
              <p>每件作品从一个阶段走到下一个阶段，进度一眼可见。</p>
            </div>
            <span className="meta-chip">{counts.works} 件作品</span>
          </div>

          <div className="track-scroll">
            <ol className="track">
              {stages.map((stage) => {
                const count = counts.stages[stage.key];

                return (
                  <li className={`track-step${count > 0 ? " has-items" : ""}`} key={stage.key}>
                    <div className="track-marker">
                      <span className="track-dot"><Icon name={stage.icon} size={19} /></span>
                    </div>
                    <div className="track-title">
                      <strong>{stage.title}</strong>
                      <span className="track-count">{count} 件</span>
                    </div>
                    <p className="track-desc">{stage.description}</p>
                  </li>
                );
              })}
            </ol>
          </div>
          <p className="track-hint">左右滑动查看完整阶段</p>
        </section>

        <aside className="panel composition-panel" aria-labelledby="composition-heading">
          <div className="panel-heading">
            <div>
              <h2 id="composition-heading">内容构成</h2>
              <p>按类型与归属查看当前结构</p>
            </div>
          </div>
          <div className="composition-body">
            <div className="composition-group">
              <p className="composition-label">按类型</p>
              <CompositionRow
                label="资产"
                count={counts.assets}
                percent={percentOf(counts.assets)}
              />
              <CompositionRow
                label="作品"
                count={counts.works}
                percent={percentOf(counts.works)}
                soft
              />
            </div>
            <div className="composition-group">
              <p className="composition-label">按归属</p>
              <CompositionRow
                label="内库"
                count={counts.internal}
                percent={percentOf(counts.internal)}
              />
              <CompositionRow
                label="外库"
                count={counts.external}
                percent={percentOf(counts.external)}
                soft
              />
            </div>
          </div>
          <div className="panel-footnote">
            <span />
            内库长期复用，外库先收集整理
          </div>
        </aside>
      </div>
    </div>
  );
}

function listHeading(filters: WorkspaceFilters): { title: string; note: string } {
  if (filters.archived === "only") {
    return { title: "已归档", note: "归档不占工作台，取消归档后回到在用" };
  }
  if (filters.q) {
    return { title: "搜索结果", note: `关键字「${filters.q}」` };
  }
  if (filters.tag) {
    return { title: `标签：${filters.tag}`, note: "按标签筛选" };
  }
  if (filters.type === "work" && filters.status) {
    return { title: statusLabels[filters.status], note: "作品阶段" };
  }
  if (filters.type === "work") return { title: "作品", note: "按阶段推进" };
  if (filters.type === "asset") return { title: "资产", note: "资料与参考" };
  if (filters.library === "internal") return { title: "内库", note: "长期复用" };
  if (filters.library === "external") return { title: "外库", note: "收集的输入" };
  return { title: "全部内容", note: `按${sortLabels[filters.sort]}排列` };
}

export function WorkspaceView({
  session,
  signOutHref = null,
  objects,
  allObjects,
  archivedObjects,
  filters,
  selected,
  selectedRefs,
  vocabulary,
}: {
  session: Session;
  signOutHref?: string | null;
  objects: BusinessObject[];
  allObjects: BusinessObject[];
  archivedObjects: BusinessObject[];
  filters: WorkspaceFilters;
  selected: BusinessObject | null;
  selectedRefs: ContentRef[];
  /** 词表快照：列表、详情、新建面板、筛选与目录共用同一份（ADR-016）。 */
  vocabulary: VocabularySnapshot;
}) {
  const now = new Date();
  const { categories } = vocabulary;
  const categoryLabels = buildCategoryLabelMap(categories);
  const tagSuggestions = [...vocabulary.tags].sort(
    (a, b) => b.usage - a.usage || a.label.localeCompare(b.label, "zh"),
  );
  const works = allObjects.filter((object) => object.type === "work");
  const assets = allObjects.filter((object) => object.type === "asset");
  const internalCount = allObjects.filter((object) => object.library === "internal").length;
  const externalCount = allObjects.length - internalCount;

  const counts: WorkspaceCounts = {
    total: allObjects.length,
    assets: assets.length,
    works: works.length,
    internal: internalCount,
    external: externalCount,
    archived: archivedObjects.length,
    stages: {
      draft: works.filter((work) => work.status === "draft").length,
      finished: works.filter((work) => work.status === "finished").length,
      published: works.filter((work) => work.status === "published").length,
      practiced: works.filter((work) => work.status === "practiced").length,
    },
  };

  const filtersActive = hasActiveFilters(filters);
  const heading = listHeading(filters);
  const conditions = activeFilterChips(filters);
  const hasConditions = Boolean(
    filters.q || filters.type || filters.library || filters.status || filters.tag,
  );
  // 点开一条时保留当前筛选，返回列表仍是同一份结果。
  const listHref = buildWorkspaceHref(filters);
  const listQuery = listHref.slice("/workspace".length);

  const emptyState = (
    <div className="record-empty">
      {filters.archived === "only" && !hasConditions ? (
        <>
          <Icon name="archive" size={22} />
          <strong>还没有归档内容</strong>
          <p>归档只改元数据、不移动内容，需要时随时可以恢复。</p>
          <Link className="btn btn-secondary" href="/workspace">回到在用</Link>
        </>
      ) : filtersActive ? (
        <>
          <Icon name="search" size={22} />
          <strong>没有匹配的内容</strong>
          <p>换个关键字，或放宽类型、库别与状态。</p>
          <div className="record-empty-chips">
            {conditions.map((condition) => (
              <span className="meta-chip" key={condition.key}>
                {condition.label}
              </span>
            ))}
          </div>
          <Link className="btn btn-secondary" href="/workspace">清空筛选</Link>
        </>
      ) : (
        <>
          <Icon name="inbox" size={22} />
          <strong>还没有内容</strong>
          <p>新建一个资产收纳资料，或新建作品开始推进四个阶段。</p>
          <CreateObjectButton
            label="新建第一条"
            vocabulary={vocabulary}
            canManageVocabulary={hasPermission(session, "vocabulary:category:write")}
          />
        </>
      )}
    </div>
  );

  const footnote = objects.length > 0 && objects.length >= LIST_LIMIT ? (
    <p className="record-footnote">
      最多显示 {LIST_LIMIT} 条，用关键字可以缩小范围
    </p>
  ) : null;

  return (
    <div className="app-frame has-list" data-selected={selected ? "true" : "false"}>
      <NavRail session={session} active="workspace" signOutHref={signOutHref} />
      <WorkspaceDirectory
        filters={filters}
        counts={counts}
        session={session}
        taxonomyCounts={{
          categories: categories.filter((item) => item.state === "active").length,
          tags: vocabulary.tags.length,
        }}
      />

      <section className="record-list" aria-label="内容列表">
        <header className="record-list-head">
          <div>
            <h2 className="record-list-title">{heading.title}</h2>
            <p className="record-list-note">{heading.note}</p>
          </div>
          <CreateObjectButton label="新建" vocabulary={vocabulary} canManageVocabulary={hasPermission(session, "vocabulary:category:write")} />
        </header>

        <RecordList
          objects={objects}
          selectedId={selected?.id ?? null}
          listQuery={listQuery}
          now={now}
          empty={emptyState}
          footnote={footnote}
          categoryLabels={categoryLabels}
        >
          <div className="record-filters">
            <ObjectFilters filters={filters} tags={vocabulary.tags} compact />
          </div>
        </RecordList>
      </section>

      <main className="record-detail">
        <div className="detail-scroll">
          <div className="workspace detail-workspace">
            {selected ? (
              <>
                <nav className="pane-back" aria-label="返回列表">
                  <Link href={listHref}>
                    <Icon name="arrow-left" size={14} />
                    返回列表
                  </Link>
                </nav>
                <ObjectDetail
                  object={selected}
                  refs={selectedRefs}
                  categoryLabels={categoryLabels}
                  categories={categories}
                  canManageVocabulary={hasPermission(session, "vocabulary:category:write")}
                  tagSuggestions={tagSuggestions}
                />
              </>
            ) : (
              <Overview
                session={session}
                allObjects={allObjects}
                counts={counts}
                now={now}
                vocabulary={vocabulary}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
