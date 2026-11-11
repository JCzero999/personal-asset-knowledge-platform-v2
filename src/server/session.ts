import { redirect } from "next/navigation";

import { createLogtoConfig, LogtoSessionAdapter } from "./adapters/session/logto";
import { MockSessionAdapter } from "./adapters/session/mock";
import type { Session, SessionPort } from "./ports/session";

/**
 * 身份解析入口。页面与接口都从这里取当前用户，不各自判断环境变量。
 *
 * `AUTH_MODE`：
 * - `mock`：本地固定身份（开发环境默认）
 * - `logto`：接入 Logto 真实登录
 * - 其他或缺省：无身份
 */

type AuthMode = "mock" | "logto" | "disabled";

export function resolveAuthMode(): AuthMode {
  const configured = process.env.AUTH_MODE?.trim().toLowerCase();

  if (configured === "mock" || configured === "logto") {
    return configured;
  }

  if (configured) {
    return "disabled";
  }

  return process.env.NODE_ENV === "production" ? "disabled" : "mock";
}

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
  return port ? port.getCurrentSession() : null;
}

/** 页面用：没有身份时回到首页，而不是渲染一个空工作台。 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();

  if (!session) {
    redirect("/");
  }

  return session;
}
