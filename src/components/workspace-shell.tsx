import Link from "next/link";

import {
  workFormats,
  type BusinessObject,
  type WorkStatus,
} from "@/domain/objects";
import { libraryLabels, statusLabels } from "@/lib/object-labels";
import {
  activeFilterChips,
  hasActiveFilters,
  LIST_LIMIT,
  sortLabels,
  type WorkspaceFilters,
} from "@/lib/workspace-filters";
import type { Session } from "@/server/ports/session";
import { CreateObjectButton } from "./create-object-dialog";
import { Icon, type IconName } from "./icon";
import { ObjectActions } from "./object-actions";
import { ObjectFilters } from "./object-filters";

const navigation: Array<{ label: string; icon: IconName; href: string; active?: boolean }> = [
  { label: "工作台", icon: "grid", href: "/workspace", active: true },
  { label: "最近内容", icon: "archive", href: "#recent" },
  { label: "作品进程", icon: "workflow", href: "#track" },
];

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

const formatLabels = new Map(workFormats.map((item) => [item.value, item.label]));

function greeting(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatUpdatedAt(iso: string, now: Date): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso.slice(0, 10);
  }

  const days = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );

  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
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

export function WorkspaceShell({
  session,
  objects,
  allObjects,
  filters,
  signOutHref = null,
}: {
  session: Session;
  /** 当前筛选与范围下的列表结果。 */
  objects: BusinessObject[];
  /** 不含归档的全量对象，用于概览、阶段与构成统计，不受列表筛选影响。 */
  allObjects: BusinessObject[];
  filters: WorkspaceFilters;
  signOutHref?: string | null;
}) {
  const now = new Date();
  const works = allObjects.filter((object) => object.type === "work");
  const assets = allObjects.filter((object) => object.type === "asset");
  const internalCount = allObjects.filter((object) => object.library === "internal").length;
  const externalCount = allObjects.length - internalCount;
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const weeklyCount = allObjects.filter(
    (object) => Date.parse(object.createdAt) >= weekAgo,
  ).length;

  const countByStatus = (status: WorkStatus) =>
    works.filter((work) => work.status === status).length;

  const filtersActive = hasActiveFilters(filters);
  const archivedView = filters.archived === "only";
  const hasConditions = Boolean(
    filters.q || filters.type || filters.library || filters.status,
  );
  // 默认视图只露最近 5 条预览；一旦用了筛选或排序，就展示完整结果。
  const rows = filtersActive ? objects : objects.slice(0, 5);
  const conditions = activeFilterChips(filters);
  const total = allObjects.length;
  const percentOf = (count: number) => (total === 0 ? 0 : Math.round((count / total) * 100));

  const listTitle = archivedView
    ? "已归档"
    : hasConditions
      ? "筛选结果"
      : filters.sort === "updated"
        ? "最近内容"
        : "全部内容";
  const listSubtitle = archivedView
    ? "归档的内容不占用工作台，取消归档后会回到在用列表。"
    : filtersActive
      ? `按${sortLabels[filters.sort]}排列`
      : "资产与作品按最近更新排列";

  const overview = [
    { label: "全部内容", value: total, icon: "inbox" as IconName },
    { label: "资产", value: assets.length, icon: "archive" as IconName },
    { label: "作品", value: works.length, icon: "workflow" as IconName },
    { label: "本周新增", value: weeklyCount, icon: "clock" as IconName },
  ];

  const todayLabel = `${now.getMonth() + 1}月${now.getDate()}日 · ${now.toLocaleDateString("zh-CN", { weekday: "long" })}`;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-copy">
            <strong>知产工作台</strong>
            <small>ASSET &amp; KNOWLEDGE</small>
          </span>
        </div>

        <nav className="main-nav" aria-label="主导航">
          <p className="nav-label">工作空间</p>
          {navigation.map((item) => (
            <a
              className={`nav-item${item.active ? " active" : ""}`}
              href={item.href}
              key={item.label}
              aria-current={item.active ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="nav-preview">
            <p className="nav-label">即将开放</p>
            <p className="preview-row"><Icon name="search" size={16} /><span>内容检索</span></p>
            <p className="preview-row"><Icon name="graph" size={16} /><span>知识图谱</span></p>
          </div>
          <div className="sidebar-user">
            <span className="sidebar-avatar" aria-hidden="true">{session.name.slice(0, 1)}</span>
            <span className="sidebar-user-copy">
              <strong>{session.name}</strong>
              <small>本地工作区</small>
            </span>
            {signOutHref ? (
              <a className="sidebar-signout" href={signOutHref}>退出</a>
            ) : null}
          </div>
        </div>
      </aside>

      <main className="workspace" id="overview">
        <header className="workspace-header">
          <div className="workspace-greeting">
            <p className="workspace-date">{todayLabel}</p>
            <h1>{greeting(now.getHours())}，{session.name}</h1>
            <p className="workspace-subtitle">把收集到的资料沉淀成资产，把想法推进成作品。</p>
          </div>
          <div className="header-actions">
            <CreateObjectButton label="新建" />
            <span className="avatar" title={session.email ?? session.name} aria-label={session.name}>
              {session.name.slice(0, 1)}
            </span>
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

        <section className="panel track-panel" id="track" aria-labelledby="track-heading">
          <div className="panel-heading">
            <div>
              <h2 id="track-heading">作品进程</h2>
              <p>每件作品从一个阶段走到下一个阶段，进度一眼可见。</p>
            </div>
            <span className="meta-chip">{works.length} 件作品</span>
          </div>

          <div className="track-scroll">
            <ol className="track">
              {stages.map((stage) => {
                const count = countByStatus(stage.key);

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

        <div className="dashboard-grid">
          <section className="panel recent-panel" id="recent" aria-labelledby="recent-heading">
            <div className="panel-heading">
              <div>
                <h2 id="recent-heading">{listTitle}</h2>
                <p>{listSubtitle}</p>
              </div>
              {filtersActive ? (
                <span className="meta-chip">{objects.length} 条</span>
              ) : (
                <CreateObjectButton label="新建" variant="secondary" />
              )}
            </div>

            <ObjectFilters filters={filters} />

            {rows.length === 0 ? (
              archivedView && !hasConditions ? (
                <div className="empty-state">
                  <span className="empty-icon"><Icon name="archive" size={26} /></span>
                  <div className="empty-copy">
                    <strong>还没有归档内容</strong>
                    <p>归档只改元数据、不移动内容，需要时随时可以恢复到在用。</p>
                  </div>
                  <Link className="btn btn-secondary empty-action" href="/workspace">
                    回到在用
                  </Link>
                </div>
              ) : filtersActive ? (
                <div className="empty-state">
                  <span className="empty-icon"><Icon name="search" size={26} /></span>
                  <div className="empty-copy">
                    <strong>没有匹配的内容</strong>
                    <p>
                      {archivedView
                        ? "归档里没有符合当前条件的内容。"
                        : "当前条件下没有内容，换个关键字或放宽筛选试试。"}
                    </p>
                  </div>
                  <div className="empty-filters" aria-label="当前筛选条件">
                    {conditions.map((condition) => (
                      <span className="meta-chip" key={condition.key}>
                        {condition.label}
                      </span>
                    ))}
                  </div>
                  <Link className="btn btn-secondary empty-action" href="/workspace">
                    清空筛选
                  </Link>
                </div>
              ) : (
                <div className="empty-state">
                  <span className="empty-icon"><Icon name="inbox" size={26} /></span>
                  <div className="empty-copy">
                    <strong>还没有内容</strong>
                    <p>新建一个资产收纳资料，或新建作品开始推进四个阶段。</p>
                  </div>
                  <CreateObjectButton label="新建第一条" className="empty-action" />
                </div>
              )
            ) : (
              <ul className="object-list">
                {rows.map((object) => {
                  const meta = object.type === "work"
                    ? `${formatLabels.get(object.format) ?? object.format} · ${statusLabels[object.status]} · ${libraryLabels[object.library]}`
                    : `资料与参考 · ${libraryLabels[object.library]}`;

                  return (
                    <li className="object-row" key={object.id}>
                      <span className={`object-type-icon ${object.type}`} aria-hidden="true">
                        <Icon name={object.type === "work" ? "workflow" : "archive"} size={18} />
                      </span>
                      <div className="object-main">
                        <strong>{object.title}</strong>
                        <small>
                          {meta}
                          {object.archivedAt ? " · 已归档" : ""}
                        </small>
                      </div>
                      <span className="object-date" title={object.updatedAt.slice(0, 10)}>
                        {formatUpdatedAt(object.updatedAt, now)}
                      </span>
                      <ObjectActions object={object} />
                    </li>
                  );
                })}
              </ul>
            )}

            {rows.length > 0
              && (filtersActive ? objects.length >= LIST_LIMIT : total > rows.length) && (
              <div className="panel-footnote">
                <span />
                {filtersActive
                  ? `最多显示 ${LIST_LIMIT} 条，用关键字可以缩小范围`
                  : `共 ${total} 条内容，这里显示最近 ${rows.length} 条`}
              </div>
            )}
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
                  count={assets.length}
                  percent={percentOf(assets.length)}
                />
                <CompositionRow
                  label="作品"
                  count={works.length}
                  percent={percentOf(works.length)}
                  soft
                />
              </div>
              <div className="composition-group">
                <p className="composition-label">按归属</p>
                <CompositionRow
                  label="内库 · 已验证"
                  count={internalCount}
                  percent={percentOf(internalCount)}
                />
                <CompositionRow
                  label="外库 · 待验证"
                  count={externalCount}
                  percent={percentOf(externalCount)}
                  soft
                />
              </div>
            </div>
            <div className="panel-footnote">
              <span />
              内库放验证过的内容，外库放待验证的输入
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
