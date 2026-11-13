import type { LogtoNextConfig } from "@logto/next";
import { getLogtoContext } from "@logto/next/server-actions";

import type { SessionIdentity, SessionPort } from "../../ports/session";

/**
 * Logto 适配器。
 *
 * 配置缺项时直接抛错：宁可启动时就暴露问题，也不要用空密钥静默降级成“未登录”。
 */

const requiredKeys = [
  "LOGTO_ENDPOINT",
  "LOGTO_APP_ID",
  "LOGTO_APP_SECRET",
  "LOGTO_COOKIE_SECRET",
] as const;

function readEnv(): Record<(typeof requiredKeys)[number], string> {
  const missing = requiredKeys.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(`AUTH_MODE=logto 缺少环境变量：${missing.join("、")}`);
  }

  return {
    LOGTO_ENDPOINT: process.env.LOGTO_ENDPOINT!.trim(),
    LOGTO_APP_ID: process.env.LOGTO_APP_ID!.trim(),
    LOGTO_APP_SECRET: process.env.LOGTO_APP_SECRET!.trim(),
    LOGTO_COOKIE_SECRET: process.env.LOGTO_COOKIE_SECRET!.trim(),
  };
}

export function createLogtoConfig(): LogtoNextConfig {
  const env = readEnv();

  return {
    endpoint: env.LOGTO_ENDPOINT.replace(/\/+$/, ""),
    appId: env.LOGTO_APP_ID,
    appSecret: env.LOGTO_APP_SECRET,
    baseUrl: (process.env.APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, ""),
    cookieSecret: env.LOGTO_COOKIE_SECRET,
    cookieSecure: process.env.NODE_ENV === "production",
  };
}

export class LogtoSessionAdapter implements SessionPort {
  constructor(private readonly config: LogtoNextConfig) {}

  async getCurrentSession(): Promise<SessionIdentity | null> {
    let context;

    try {
      context = await getLogtoContext(this.config);
    } catch (error) {
      // 过期或损坏的会话 Cookie 视同未登录，下一次请求重新走登录。
      console.warn("[session] 读取 Logto 会话失败，按未登录处理", error);
      return null;
    }

    const claims = context.claims;

    if (!context.isAuthenticated || !claims?.sub) {
      return null;
    }

    return {
      sub: claims.sub,
      name: claims.name ?? claims.username ?? claims.email ?? "用户",
      email: claims.email ?? null,
    };
  }
}
