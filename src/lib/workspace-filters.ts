import {
  isLibrary,
  isObjectType,
  isWorkStatus,
  type Library,
  type ObjectType,
  type WorkStatus,
} from "@/domain/objects";
import { libraryLabels, statusLabels } from "@/lib/object-labels";
import type { ListObjectsQuery } from "@/server/ports/object-repository";

/**
 * 工作台列表的筛选状态：URL 是唯一真相，服务端组件据此查询，
 * 客户端控件只负责把变化写回 URL。这里不引入任何 IO。
 */

export const workspaceSorts = ["updated", "created", "title"] as const;
export type WorkspaceSort = (typeof workspaceSorts)[number];

export const sortLabels: Record<WorkspaceSort, string> = {
  updated: "最近更新",
  created: "最近创建",
  title: "标题",
};

/** active = 在用（不含归档）；only = 只看已归档。 */
export type ArchiveScope = "active" | "only";

export interface WorkspaceFilters {
  /** 标题或描述关键字，已 trim。 */
  q: string;
  type: ObjectType | null;
  library: Library | null;
  status: WorkStatus | null;
  /** 标签名称（展示写法）；查询前由仓储按归一化键匹配。 */
  tag: string | null;
  sort: WorkspaceSort;
  archived: ArchiveScope;
}

export const defaultWorkspaceFilters: WorkspaceFilters = {
  q: "",
  type: null,
  library: null,
  status: null,
  tag: null,
  sort: "updated",
  archived: "active",
};

/** 列表一次取多少条：够用即可，再多就提示用关键字缩小范围。 */
export const LIST_LIMIT = 100;

/** 概览与阶段统计需要的全量上限（与 API 的 limit 上限一致）。 */
export const SUMMARY_LIMIT = 200;

export type WorkspaceSearchParams = Record<string, string | string[] | undefined>;

function readParam(params: WorkspaceSearchParams, key: string): string {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() ?? "";
}

/**
 * 把 URL 参数解析成筛选状态。
 *
 * 这里刻意「宽松」：页面不该因为一个手改坏的 URL 整页报错，非法值退回默认。
 * API 层（`parseListObjectsQuery`）仍然对非法值返回 400，两者职责不同。
 *
 * 状态只对作品有意义：类型为资产时直接丢弃 status，避免拼出必然为空的组合。
 */
export function parseWorkspaceFilters(params: WorkspaceSearchParams): WorkspaceFilters {
  const typeRaw = readParam(params, "type");
  const type = isObjectType(typeRaw) ? typeRaw : null;

  const libraryRaw = readParam(params, "library");
  const library = isLibrary(libraryRaw) ? libraryRaw : null;

  const statusRaw = readParam(params, "status");
  const status = isWorkStatus(statusRaw) && type !== "asset" ? statusRaw : null;

  const sortRaw = readParam(params, "sort");
  const sort = workspaceSorts.includes(sortRaw as WorkspaceSort)
    ? (sortRaw as WorkspaceSort)
    : defaultWorkspaceFilters.sort;

  const archived: ArchiveScope = readParam(params, "archived") === "only" ? "only" : "active";
  const tag = readParam(params, "tag").slice(0, 64) || null;

  return { q: readParam(params, "q"), type, library, status, tag, sort, archived };
}

/** 是否偏离了默认视图（决定标题、空状态文案与「清空筛选」是否出现）。 */
export function hasActiveFilters(filters: WorkspaceFilters): boolean {
  return (
    filters.q !== "" ||
    filters.type !== null ||
    filters.library !== null ||
    filters.status !== null ||
    filters.tag !== null ||
    filters.sort !== defaultWorkspaceFilters.sort ||
    filters.archived !== defaultWorkspaceFilters.archived
  );
}

/**
 * 生成筛选链接：默认值不写进 URL，保证地址干净、历史记录稳定。
 * 类型切到资产时会自动丢掉 status（两者不可能同时成立）。
 */
export function buildWorkspaceHref(
  filters: WorkspaceFilters,
  patch: Partial<WorkspaceFilters> = {},
): string {
  const next: WorkspaceFilters = { ...filters, ...patch };
  if (next.type === "asset") {
    next.status = null;
  }

  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.type) params.set("type", next.type);
  if (next.library) params.set("library", next.library);
  if (next.status) params.set("status", next.status);
  if (next.tag) params.set("tag", next.tag);
  if (next.sort !== "updated") params.set("sort", next.sort);
  if (next.archived === "only") params.set("archived", "only");

  const query = params.toString();
  return query ? `/workspace?${query}` : "/workspace";
}

/** 交给 `listObjects` 的查询条件（ownerSub 由调用方补）。 */
export function toListObjectsQuery(
  filters: WorkspaceFilters,
  limit: number,
): Omit<ListObjectsQuery, "ownerSub"> {
  return {
    ...(filters.q ? { search: filters.q } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.library ? { library: filters.library } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    sort: filters.sort,
    ...(filters.archived === "only" ? { archivedOnly: true } : {}),
    limit,
  };
}

export interface ActiveFilterChip {
  key: string;
  label: string;
}

/** 空状态与标题里用的中文条件清单，顺序与工具条一致。 */
export function activeFilterChips(filters: WorkspaceFilters): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];

  if (filters.q) chips.push({ key: "q", label: `关键字「${filters.q}」` });
  if (filters.type) {
    chips.push({ key: "type", label: filters.type === "asset" ? "资产" : "作品" });
  }
  if (filters.library) {
    chips.push({ key: "library", label: libraryLabels[filters.library] });
  }
  if (filters.status) {
    chips.push({ key: "status", label: statusLabels[filters.status] });
  }
  if (filters.tag) {
    chips.push({ key: "tag", label: `标签「${filters.tag}」` });
  }
  if (filters.archived === "only") chips.push({ key: "archived", label: "已归档" });
  if (filters.sort !== "updated") {
    chips.push({ key: "sort", label: `按${sortLabels[filters.sort]}排序` });
  }

  return chips;
}
