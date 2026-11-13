/**
 * 身份端口。
 *
 * server 组件与 route handler 只依赖这个接口，不直接触碰 Logto；
 * 本地开发用 MockSessionAdapter，接入 Logto 后换成真实适配器即可。
 * 当前为单用户（ADR-003），`sub` 仍是 Logto 的用户标识，便于后续演进。
 */

/** 适配器只负责证明「你是谁」。 */
export interface SessionIdentity {
  sub: string;
  name: string;
  email: string | null;
}

/**
 * 上层拿到的会话。
 *
 * `userId` 与 `permissions` 来自本地授权表（ADR-019）；`isAdmin` 是纯 UI
 * 便利标记（= 拥有 owner 或 admin 角色），**授权一律看 permissions**。
 */
export interface Session extends SessionIdentity {
  userId: string | null;
  permissions: string[];
  isAdmin: boolean;
}

export interface SessionPort {
  getCurrentSession(): Promise<SessionIdentity | null>;
}
