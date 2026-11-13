import type { ReactNode } from "react";
import Link from "next/link";

import type { Session } from "@/server/ports/session";
import { resolveAuthMode } from "@/server/roles";

import { AdminDirectory, type TaxonomyCounts } from "./directory";
import { Icon } from "./icon";
import { NavRail } from "./nav-rail";

/**
 * 系统页的统一骨架（ADR-019）。
 *
 * 每个页面自己先判定权限再读数据，这里只负责导航、页头与内容区，
 * 403 由 `AdminForbidden` 统一呈现——页面不各写一份空白版式。
 */

function railSignOutHref(): string | null {
  return resolveAuthMode() === "logto" ? "/api/logto/sign-out" : null;
}

export function AdminPageShell({
  session,
  active,
  kicker,
  title,
  description,
  actions,
  taxonomyCounts,
  children,
}: {
  session: Session;
  /** 当前路径，用于目录高亮。 */
  active: string;
  kicker: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  taxonomyCounts?: TaxonomyCounts;
  children: ReactNode;
}) {
  return (
    <div className="app-frame">
      <NavRail session={session} active="admin" signOutHref={railSignOutHref()} />
      <AdminDirectory session={session} active={active} taxonomyCounts={taxonomyCounts} />

      <main className="record-detail">
        <div className="detail-scroll">
          <div className="workspace admin-workspace">
            <header className="workspace-header admin-page-head">
              <div className="workspace-greeting">
                <p className="workspace-date">{kicker}</p>
                <h1>{title}</h1>
                {description ? <p className="workspace-subtitle">{description}</p> : null}
              </div>
              {actions ? <div className="header-actions">{actions}</div> : null}
            </header>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * 无权限页：说明缺的是哪一个权限，并给出回到自己内容的路。
 * 仍然渲染导航与目录（目录本身按权限过滤），不做成孤立死页。
 */
export function AdminForbidden({
  session,
  area,
  permission,
}: {
  session: Session;
  area: string;
  permission?: string;
}) {
  return (
    <div className="app-frame">
      <NavRail session={session} active="admin" signOutHref={railSignOutHref()} />
      <AdminDirectory session={session} active="" />

      <main className="record-detail">
        <div className="detail-scroll">
          <div className="workspace">
            <header className="workspace-header">
              <div className="workspace-greeting">
                <p className="workspace-date">系统 · {area}</p>
                <h1>没有访问权限</h1>
                <p className="workspace-subtitle">当前账号缺少进入「{area}」所需的权限。</p>
              </div>
            </header>
            <section className="panel empty-state" role="alert">
              <span className="empty-icon"><Icon name="alert" size={26} /></span>
              <div className="empty-copy">
                <strong>当前账号没有{area}权限</strong>
                <p>
                  后台权限按角色分配{permission ? `，这里需要「${permission}」` : ""}。
                  需要开通时联系项目所有者，在「系统 · 用户」里调整角色。
                </p>
                <Link className="btn btn-secondary" href="/workspace">回到工作台</Link>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
