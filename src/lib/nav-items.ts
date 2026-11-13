import type { IconName } from "@/components/icon";

/**
 * 一级导航的唯一数据源（ADR-018 第 4 条）。
 *
 * 左侧图标栏与首页抽屉都从这里读，避免「改一处漏一处」；
 * 管理员多出来的项用 `adminOnly` 声明，不在调用处再写一份判断。
 */

export type NavKey = "workspace" | "search" | "graph" | "admin";

export interface NavItem {
  key: NavKey;
  label: string;
  icon: IconName;
  href: string;
  /** 仅管理员可见；`navItemsFor` 负责过滤。 */
  adminOnly?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "workspace", label: "工作台", icon: "grid", href: "/workspace" },
  { key: "search", label: "检索", icon: "search", href: "/search" },
  { key: "graph", label: "图谱", icon: "graph", href: "/graph" },
  { key: "admin", label: "系统", icon: "settings", href: "/admin", adminOnly: true },
];

/** 当前身份可见的导航项。图标栏与抽屉共用，顺序即展示顺序。 */
export function navItemsFor(isAdmin: boolean): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);
}
