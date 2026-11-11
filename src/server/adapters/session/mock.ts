import type { Session, SessionPort } from "../../ports/session";

/**
 * 本地开发用的固定身份。
 *
 * 只在 `AUTH_MODE=mock`（开发环境默认）时启用；生产环境默认不开，
 * 没有真实 Logto 会话就不放行，避免把 Mock 身份当成已登录。
 */

export const mockSession: Session = {
  sub: "mock-local-user",
  name: "林默",
  email: null,
};

export class MockSessionAdapter implements SessionPort {
  async getCurrentSession(): Promise<Session | null> {
    return mockSession;
  }
}
