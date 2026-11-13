import Link from "next/link";

import type { WorkStatus } from "@/domain/objects";
import {
  buildWorkspaceHref,
  defaultWorkspaceFilters,
  type ArchiveScope,
  type WorkspaceFilters,
} from "@/lib/workspace-filters";
import { hasPermission } from "@/server/authz";
import type { Session } from "@/server/ports/session";
import type { NavKey } from "./nav-rail";

/**
 * 第二列「目录」：当前模块内部的浏览入口。
 *
 * 旧项目这里是可展开的二级目录，我们保留它的层级感，但把入口映射到已有的
 * URL 筛选条件上——目录只是筛选的快捷方式，不引入第二套状态。
 */

export interface WorkspaceCounts {
  total: number;
  assets: number;
  works: number;
  internal: number;
  external: number;
  archived: number;
  stages: Record<WorkStatus, number>;
}

interface DirItem {
  label: string;
  href: string;
  active: boolean;
  count?: number;
  /** 同一路径只换 hash 时 Next 的 Link 不会滚动，页内锚点必须用原生 <a>。 */
  anchor?: boolean;
}

function DirLink({ item }: { item: DirItem }) {
  const className = `dir-item${item.active ? " is-active" : ""}`;
  const content = (
    <>
      <span className="dir-item-label">{item.label}</span>
      {item.count !== undefined ? <span className="dir-count">{item.count}</span> : null}
    </>
  );

  if (item.anchor) {
    return (
      <a className={className} href={item.href} aria-current={item.active ? "page" : undefined}>
        {content}
      </a>
    );
  }

  return (
    <Link className={className} href={item.href} aria-current={item.active ? "page" : undefined}>
      {content}
    </Link>
  );
}

function DirGroup({
  label,
  items,
  nested = false,
}: {
  label: string;
  items: DirItem[];
  /** 二级条目：相对分组标题缩进一层，用来表达从属关系。 */
  nested?: boolean;
}) {
  return (
    <div className={`dir-group${nested ? " is-nested" : ""}`}>
      <p className="dir-label">{label}</p>
      {items.map((item) => (
        <DirLink item={item} key={item.href} />
      ))}
    </div>
  );
}

/**
 * 目录里的「管理」入口（ADR-019）：按权限出现，不再是「是不是管理员」一刀切。
 * 四个模块共用同一套分组，保证同一权限在任何页面都能找到同一个入口。
 */
export interface TaxonomyCounts {
  /** 启用分类数；不传则不显示计数。 */
  categories?: number;
  /** 标签总数；不传则不显示计数。 */
  tags?: number;
}

function VocabularyGroup({
  session,
  counts,
  active = null,
}: {
  session: Session | null;
  counts?: TaxonomyCounts;
  active?: "categories" | "tags" | null;
}) {
  const items: DirItem[] = [];
  if (hasPermission(session, "vocabulary:category:write")) {
    items.push({
      label: "管理分类",
      href: "/admin/vocabulary/categories",
      active: active === "categories",
      count: counts?.categories,
    });
  }
  if (hasPermission(session, "vocabulary:tag:write")) {
    items.push({
      label: "管理标签",
      href: "/admin/vocabulary/tags",
      active: active === "tags",
      count: counts?.tags,
    });
  }
  if (items.length === 0) return null;

  return <DirGroup label="分类与标签" items={items} />;
}

function AccountGroup({
  session,
  active = null,
}: {
  session: Session | null;
  active?: string | null;
}) {
  if (!hasPermission(session, "user:read")) return null;

  const items: DirItem[] = [
    { label: "用户", href: "/admin/users", active: active === "/admin/users" },
    { label: "角色", href: "/admin/roles", active: active === "/admin/roles" },
  ];

  return <DirGroup label="账号" items={items} />;
}

/** 工作台、检索、图谱三个模块的「管理」入口：只有词表与账号两组。 */
function ManageGroups({
  session,
  counts,
  active = null,
}: {
  session: Session | null;
  counts?: TaxonomyCounts;
  active?: string | null;
}) {
  if (!session) return null;

  return (
    <>
      <VocabularyGroup session={session} counts={counts} />
      <AccountGroup session={session} active={active} />
    </>
  );
}

const stages: Array<{ key: WorkStatus; label: string }> = [
  { key: "draft", label: "草稿" },
  { key: "finished", label: "已完成" },
  { key: "published", label: "已发布" },
  { key: "practiced", label: "已实践" },
];

/** 目录点击一律从默认条件出发，避免「上次的筛选」把新入口变成空结果。 */
function hrefFor(patch: Partial<WorkspaceFilters>): string {
  return buildWorkspaceHref(defaultWorkspaceFilters, patch);
}

function isPlain(filters: WorkspaceFilters, archive: ArchiveScope = "active"): boolean {
  return (
    filters.q === ""
    && filters.type === null
    && filters.library === null
    && filters.status === null
    && filters.archived === archive
  );
}

export function WorkspaceDirectory({
  filters,
  counts,
  session = null,
  taxonomyCounts,
}: {
  filters: WorkspaceFilters;
  counts: WorkspaceCounts;
  session?: Session | null;
  taxonomyCounts?: TaxonomyCounts;
}) {
  const browse: DirItem[] = [
    { label: "全部内容", href: hrefFor({}), active: isPlain(filters), count: counts.total },
    {
      label: "资产",
      href: hrefFor({ type: "asset" }),
      active: filters.q === "" && filters.type === "asset" && filters.library === null,
      count: counts.assets,
    },
    {
      label: "作品",
      href: hrefFor({ type: "work" }),
      active:
        filters.q === ""
        && filters.type === "work"
        && filters.library === null
        && filters.status === null,
      count: counts.works,
    },
    {
      label: "已归档",
      href: hrefFor({ archived: "only" }),
      active: filters.archived === "only",
      count: counts.archived,
    },
  ];

  const libraries: DirItem[] = [
    {
      label: "内库",
      href: hrefFor({ library: "internal" }),
      active: filters.q === "" && filters.library === "internal" && filters.type === null,
      count: counts.internal,
    },
    {
      label: "外库",
      href: hrefFor({ library: "external" }),
      active: filters.q === "" && filters.library === "external" && filters.type === null,
      count: counts.external,
    },
  ];

  const track: DirItem[] = stages.map((stage) => ({
    label: stage.label,
    href: hrefFor({ type: "work", status: stage.key }),
    active:
      filters.q === ""
      && filters.type === "work"
      && filters.status === stage.key,
    count: counts.stages[stage.key],
  }));

  return (
    <aside className="directory" aria-label="工作台目录">
      <header className="dir-head">
        <strong>工作台</strong>
        <span>资产与作品</span>
      </header>
      <DirGroup label="浏览" items={browse} />
      <DirGroup label="归属" items={libraries} />
      <DirGroup label="作品进程" items={track} nested />
      <ManageGroups session={session} counts={taxonomyCounts} />
      <p className="dir-note">目录只切换列表范围，内容本身不动。</p>
    </aside>
  );
}

export function SearchDirectory({
  library,
  session = null,
  taxonomyCounts,
}: {
  library: string | null;
  session?: Session | null;
  taxonomyCounts?: TaxonomyCounts;
}) {
  const items: DirItem[] = [
    { label: "全部库别", href: "/search", active: library === null },
    { label: "内库", href: "/search?library=internal", active: library === "internal" },
    { label: "外库", href: "/search?library=external", active: library === "external" },
  ];

  return (
    <aside className="directory" aria-label="检索目录">
      <header className="dir-head">
        <strong>内容检索</strong>
        <span>语义查找</span>
      </header>
      <DirGroup label="检索范围" items={items} />
      <ManageGroups session={session} counts={taxonomyCounts} />
      <p className="dir-note">检索按语义匹配段落，不是关键词精确命中。</p>
    </aside>
  );
}

export function GraphDirectory({
  session = null,
  taxonomyCounts,
}: {
  session?: Session | null;
  taxonomyCounts?: TaxonomyCounts;
} = {}) {
  const items: DirItem[] = [
    { label: "实体与关系", href: "/graph#graph-canvas", active: true, anchor: true },
    { label: "图问答", href: "/graph#graph-qa", active: false, anchor: true },
  ];

  return (
    <aside className="directory" aria-label="图谱目录">
      <header className="dir-head">
        <strong>知识图谱</strong>
        <span>实体与关系</span>
      </header>
      <DirGroup label="浏览" items={items} />
      <ManageGroups session={session} counts={taxonomyCounts} />
      <p className="dir-note">图谱来自已解析内容的实体抽取，本机抽取较慢。</p>
    </aside>
  );
}

export function AdminDirectory({
  session,
  active = "/admin",
  taxonomyCounts,
}: {
  session: Session;
  /** 当前页面的路径，用于高亮。 */
  active?: string;
  taxonomyCounts?: TaxonomyCounts;
}) {
  const overview: DirItem[] = [
    { label: "总览", href: "/admin", active: active === "/admin" },
    { label: "全部内容", href: "/admin/objects", active: active === "/admin/objects" },
  ];

  const system: DirItem[] = [];
  if (hasPermission(session, "system:read")) {
    system.push({ label: "系统状态", href: "/admin/system", active: active === "/admin/system" });
  }
  if (hasPermission(session, "audit:read")) {
    system.push({ label: "审计日志", href: "/admin/audit", active: active === "/admin/audit" });
  }

  return (
    <aside className="directory" aria-label="系统目录">
      <header className="dir-head">
        <strong>系统</strong>
        <span>运营与账号</span>
      </header>
      <DirGroup label="概览" items={overview} />
      <VocabularyGroup
        session={session}
        counts={taxonomyCounts}
        active={
          active === "/admin/vocabulary/categories"
            ? "categories"
            : active === "/admin/vocabulary/tags"
              ? "tags"
              : null
        }
      />
      <AccountGroup session={session} active={active} />
      {system.length > 0 ? <DirGroup label="运维" items={system} /> : null}
      <p className="dir-note">只读统计与两个维护动作，改内容仍回工作台。</p>
    </aside>
  );
}

export type DirectoryKey = NavKey;
