import { redirect } from "next/navigation";

import { createLogtoConfig, LogtoSessionAdapter } from "./adapters/session/logto";
import { MockSessionAdapter } from "./adapters/session/mock";
import type { Session, SessionIdentity, SessionPort } from "./ports/session";
import { resolveAuthMode } from "./roles";
import { getDb } from "./db/client";
import { resolveSessionAccess } from "./services/user-service";

export { resolveAuthMode };

/**
 * 身份解析入口。页面与接口都从这里取当前用户。
 *
 * Logto 只证明「你是谁」；角色与权限由本地授权表解析（ADR-019）。
 * `ADMIN_SUBS` 只在「库里没有 active owner」时作为引导通道生效。
 *
 * `AUTH_MODE`：
 * - `mock`：本地固定身份（开发环境默认，固定为 owner）
 * - `logto`：接入 Logto 真实登录
 * - 其他或缺省：无身份
 */

function createPort(): SessionPort | null {
  switch (resolveAuthMode()) {
    case "mock":
      return new MockSessionAdapter();
    case "logto":
      return new LogtoSessionAdapter(createLogtoConfig());
    case "disabled":
      return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const port = createPort();
  if (!port) return null;

  const identity: SessionIdentity | null = await port.getCurrentSession();
  if (!identity) return null;

  const authMode = resolveAuthMode();
  const access = resolveSessionAccess(getDb(), identity, {
    authMode,
    adminSubs: process.env.ADMIN_SUBS,
  });

  return {
    ...identity,
    userId: access.userId,
    permissions: access.permissions,
    // UI 便利标记，只用于导航与入口显隐；授权判定只看 permissions。
    isAdmin: access.roles.includes("owner") || access.roles.includes("admin"),
  };
}

/** 页面用：没有身份时回到首页，而不是渲染一个空工作台。 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();

  if (!session) {
    redirect("/");
  }

  return session;
}
