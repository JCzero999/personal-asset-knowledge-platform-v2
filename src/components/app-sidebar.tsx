import Link from "next/link";

import type { Session } from "@/server/ports/session";
import { Icon, type IconName } from "./icon";

export type NavKey = "workspace" | "search";

interface NavItem {
  key: NavKey | "recent" | "track";
  label: string;
  icon: IconName;
  href: string;
}

const navigation: NavItem[] = [
  { key: "workspace", label: "工作台", icon: "grid", href: "/workspace" },
  { key: "search", label: "内容检索", icon: "search", href: "/search" },
  { key: "recent", label: "最近内容", icon: "archive", href: "/workspace#recent" },
  { key: "track", label: "作品进程", icon: "workflow", href: "/workspace#track" },
];

/**
 * 登录后的统一侧栏。工作台、检索与详情共用同一份导航，
 * 只靠 `active` 切换选中态，避免每个页面各写一套侧栏导致样式漂移。
 */
export function AppSidebar({
  session,
  active,
  signOutHref = null,
}: {
  session: Session;
  active: NavKey;
  signOutHref?: string | null;
}) {
  return (
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
        {navigation.map((item) => {
          const isActive = item.key === active;

          return (
            <Link
              className={`nav-item${isActive ? " active" : ""}`}
              href={item.href}
              key={item.key}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <div className="nav-preview">
          <p className="nav-label">即将开放</p>
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
  );
}
