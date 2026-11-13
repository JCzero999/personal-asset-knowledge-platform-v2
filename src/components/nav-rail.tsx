import Link from "next/link";

import { navItemsFor, type NavKey } from "@/lib/nav-items";
import type { Session } from "@/server/ports/session";
import { GalaxyMark } from "./galaxy-mark";
import { Icon } from "./icon";
import { ThemeSwitcher } from "./theme-switcher";

export type { NavKey } from "@/lib/nav-items";

/**
 * 最左侧图标栏（旧项目 68px 一级栏的同构做法）：
 * 图标 + 文字常驻，当前模块高亮；账号与退出收在底部，避免占目录栏的宽度。
 *
 * 导航项来自 `src/lib/nav-items.ts`（ADR-018 第 4 条），首页抽屉读同一份。
 */
export function NavRail({
  session,
  active,
  signOutHref = null,
}: {
  session: Session;
  active: NavKey;
  signOutHref?: string | null;
}) {
  const navigation = navItemsFor(session.isAdmin);

  return (
    <aside className="nav-rail">
      <Link className="rail-brand" href="/" aria-label="返回首页">
        <span className="rail-brand-badge">
          <GalaxyMark id="galaxy-mark-rail" size={28} />
        </span>
      </Link>

      <nav className="rail-nav" aria-label="主导航">
        {navigation.map((item) => {
          const isActive = item.key === active;

          return (
            <Link
              className={`rail-item${isActive ? " is-active" : ""}`}
              href={item.href}
              key={item.key}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon name={item.icon} size={21} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="rail-bottom">
        <ThemeSwitcher
          variant="rail"
          userName={session.name}
          userEmail={session.email}
          isAdmin={session.isAdmin}
          signOutHref={signOutHref}
        />
      </div>
    </aside>
  );
}
