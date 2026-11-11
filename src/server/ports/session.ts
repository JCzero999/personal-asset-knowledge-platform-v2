/**
 * 身份端口。
 *
 * server 组件与 route handler 只依赖这个接口，不直接触碰 Logto；
 * 本地开发用 MockSessionAdapter，接入 Logto 后换成真实适配器即可。
 * 当前为单用户（ADR-003），`sub` 仍是 Logto 的用户标识，便于后续演进。
 */

export interface Session {
  sub: string;
  name: string;
  email: string | null;
}

export interface SessionPort {
  getCurrentSession(): Promise<Session | null>;
}
