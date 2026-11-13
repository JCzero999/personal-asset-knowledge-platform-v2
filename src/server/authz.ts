import { fail } from "./http/respond";
import { getDb } from "./db/client";
import { recordDeniedAudit } from "./services/audit-service";
import type { Session } from "./ports/session";

/**
 * 授权模型（ADR-019）——13 项权限 × 4 个系统角色。
 *
 * 这里是权限的**唯一代码来源**：迁移把同一份清单灌进 `permissions` 表，
 * 启动与测试各校验一次两边一致（ADR-019 风险 A7）。
 *
 * `requirePermission` 是唯一强制层：所有 `/api/**` 写接口第一行调用它；
 * 页面与按钮只按 `can()` 显隐，UI 永不是安全边界。
 */

export interface PermissionDefinition {
  key: string;
  label: string;
  groupKey: string;
  sortOrder: number;
}

export const PERMISSIONS = [
  { key: "object:read", label: "查看内容", groupKey: "内容", sortOrder: 10 },
  { key: "object:write", label: "新建与编辑内容", groupKey: "内容", sortOrder: 20 },
  { key: "object:delete", label: "删除内容（软删）", groupKey: "内容", sortOrder: 30 },
  { key: "object:export", label: "导出 Markdown", groupKey: "内容", sortOrder: 40 },
  { key: "vocabulary:category:write", label: "管理分类词表", groupKey: "词表", sortOrder: 50 },
  { key: "vocabulary:tag:write", label: "管理标签词表", groupKey: "词表", sortOrder: 60 },
  { key: "content:sync", label: "手动同步队列", groupKey: "运维", sortOrder: 70 },
  { key: "content:parse", label: "推进解析状态", groupKey: "运维", sortOrder: 80 },
  { key: "system:read", label: "查看运行时信息", groupKey: "后台", sortOrder: 90 },
  { key: "audit:read", label: "查看审计日志", groupKey: "后台", sortOrder: 100 },
  { key: "user:read", label: "查看用户与角色", groupKey: "账号", sortOrder: 110 },
  { key: "user:write", label: "修改用户角色与状态", groupKey: "账号", sortOrder: 120 },
  { key: "role:write", label: "修改角色定义（预留）", groupKey: "账号", sortOrder: 130 },
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map(
  (item) => item.key,
);

export interface RoleDefinition {
  key: string;
  label: string;
  isSystem: boolean;
  sortOrder: number;
}

export const ROLES = [
  { key: "owner", label: "所有者", isSystem: true, sortOrder: 10 },
  { key: "admin", label: "管理员", isSystem: true, sortOrder: 20 },
  { key: "editor", label: "编辑", isSystem: true, sortOrder: 30 },
  { key: "viewer", label: "只读", isSystem: true, sortOrder: 40 },
] as const satisfies readonly RoleDefinition[];

export type RoleKey = (typeof ROLES)[number]["key"];

export const ROLE_KEYS: readonly RoleKey[] = ROLES.map((role) => role.key);

/**
 * 角色 → 权限矩阵，与 ADR-019 表格逐格一致。
 * `role:write` 存在但 v1 不开放写入（角色不可自定义），列出来只为矩阵完整。
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  owner: PERMISSION_KEYS,
  admin: PERMISSION_KEYS.filter(
    (key) => key !== "user:write" && key !== "role:write",
  ),
  editor: ["object:read", "object:write"],
  viewer: ["object:read"],
};

/** 后续写服务与审计共用：`sub` 是身份快照，`userId` 可为空（审计存活到用户删除之后）。 */
export interface ActorContext {
  sub: string;
  userId: string | null;
  permissions: readonly string[];
}

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value);
}

/** 多个角色的权限取并集（单机 v1 每人一个角色，但表结构允许多个）。 */
export function permissionsForRoles(roles: readonly string[]): PermissionKey[] {
  const granted = new Set<PermissionKey>();

  for (const role of roles) {
    if (!isRoleKey(role)) continue;
    for (const permission of ROLE_PERMISSIONS[role]) {
      granted.add(permission);
    }
  }

  return PERMISSION_KEYS.filter((key) => granted.has(key));
}

export function hasPermission(
  session: Pick<Session, "permissions"> | null | undefined,
  key: PermissionKey,
): boolean {
  return Boolean(session?.permissions.includes(key));
}

export function toActor(
  session: Pick<Session, "sub" | "userId" | "permissions">,
): ActorContext {
  return {
    sub: session.sub,
    userId: session.userId,
    permissions: [...session.permissions],
  };
}

/**
 * 唯一强制层。返回 null 表示放行；否则返回可直接 `return` 的 401/403 响应。
 *
 * 403 拒绝记录（`result='denied'`）在这里独立落库：它没有业务写可回滚，
 * 写失败只记应用日志，**绝不放行**（ADR-019 第 8 条）。
 */
export function requirePermission(
  session: Session | null,
  key: PermissionKey,
  message = "当前账号没有执行该操作的权限",
): Response | null {
  return requirePermissionWith(getDb(), session, key, message);
}

/**
 * 任一权限满足即放行（ADR-023 第 8 条的内联创建：`object:write` 或词表权限）。
 * 仍是同一个强制层，只是断言从「必须有 A」放宽为「A 或 B」。
 */
export function requireAnyPermission(
  session: Session | null,
  keys: readonly PermissionKey[],
  message = "当前账号没有执行该操作的权限",
): Response | null {
  if (!session) {
    return fail("UNAUTHORIZED", "请先登录");
  }

  if (keys.some((key) => hasPermission(session, key))) {
    return null;
  }

  recordDeniedAudit(getDb(), session, keys[0]);

  return fail("FORBIDDEN", message, { permission: keys[0], permissions: keys });
}

/** 测试与脚本可注入连接，避免碰真实 data/app.db。 */
export function requirePermissionWith(
  db: Parameters<typeof recordDeniedAudit>[0],
  session: Session | null,
  key: PermissionKey,
  message = "当前账号没有执行该操作的权限",
): Response | null {
  if (!session) {
    return fail("UNAUTHORIZED", "请先登录");
  }

  if (hasPermission(session, key)) {
    return null;
  }

  recordDeniedAudit(db, session, key);

  return fail("FORBIDDEN", message, { permission: key });
}
