/**
 * 身份模式与旧白名单工具。
 *
 * 单独成模块是为了能被纯函数测试：不读环境、不碰 Logto，
 * 调用方把身份模式与白名单原样传进来（ADR-012）。
 *
 * ADR-019 起 `ADMIN_SUBS` 不再是授权源：它只在「库里没有任何 active owner」
 * 时作为首次引导与逃生舱（见 `server/services/user-service.ts`）。
 */

export type AuthMode = "mock" | "logto" | "disabled";

/** 运行环境 → 身份模式。生产环境默认关闭，避免 mock 身份被当成已登录。 */
export function resolveAuthMode(env: { AUTH_MODE?: string; NODE_ENV?: string } = process.env): AuthMode {
  const configured = env.AUTH_MODE?.trim().toLowerCase();

  if (configured === "mock" || configured === "logto") {
    return configured;
  }

  if (configured) {
    return "disabled";
  }

  return env.NODE_ENV === "production" ? "disabled" : "mock";
}

/** `ADMIN_SUBS`：逗号或空白分隔的 Logto `sub`（ADR-019 起为引导白名单）。 */
export function parseAdminSubs(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 旧版「是否管理员」纯函数，保留给引导判定与 mock 语义的单元测试。
 * 生产授权已改由本地角色表承担，任何判定都不再调用它。
 */
export function computeIsAdmin(input: {
  sub: string;
  authMode: AuthMode;
  adminSubs: string | undefined;
}): boolean {
  if (input.authMode === "mock") {
    return true;
  }

  return parseAdminSubs(input.adminSubs).includes(input.sub);
}
