import type { ActorContext } from "../../src/server/authz";

/**
 * 测试用 actor。写服务签名要求显式 actor（ADR-019），
 * 测试只关心归属与审计的主体，不构造真实权限表。
 */
export function actor(sub: string, permissions: string[] = []): ActorContext {
  return { sub, userId: null, permissions };
}
