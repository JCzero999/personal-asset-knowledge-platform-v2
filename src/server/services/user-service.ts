import { and, count, eq, isNull } from "drizzle-orm";

import { DomainError, NotFoundError, ValidationError } from "../../domain/errors";
import type { SessionIdentity } from "../ports/session";
import {
  isRoleKey,
  PERMISSIONS,
  permissionsForRoles,
  ROLES,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  type ActorContext,
  type PermissionKey,
  type RoleKey,
} from "../authz";
import type { AppDatabase } from "../db/client";
import { ulid } from "../db/id";
import { objects, permissions, rolePermissions, roles, userRoles, users } from "../db/schema";
import { writeAudit } from "./audit-service";

/**
 * 本地授权（ADR-019）：users / roles / permissions / role_permissions / user_roles
 * 是唯一真相源；Logto 只证明 `sub`。
 *
 * 引导规则（ADR-019 第 7 条）：
 * - 库里没有任何 active owner 时，`ADMIN_SUBS` 命中者首次登录被写入 users 并授予 owner；
 * - 一旦存在 active owner，`ADMIN_SUBS` 退出授权判断；
 * - owner 全失联时同一条件重新成立（逃生舱），另有 `npm run admin:grant` 离线恢复；
 * - `AUTH_MODE=mock` 的固定身份始终是 owner（与旧行为一致，仅开发环境）。
 */

type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

/** 新登录且未命中引导的账号默认只读：所有登录用户共享同一批内容（ADR-003 保留部分）。 */
export const DEFAULT_ROLE: RoleKey = "viewer";

export interface SessionAccess {
  userId: string | null;
  roles: string[];
  permissions: PermissionKey[];
  state: "active" | "disabled";
}

export interface SessionAccessOptions {
  authMode: "mock" | "logto" | "disabled";
  adminSubs: string | undefined;
  now?: string;
}

export interface AdminUser {
  id: string;
  sub: string;
  displayName: string;
  email: string | null;
  state: "active" | "disabled";
  roles: string[];
  createdAt: string;
  lastSeenAt: string;
  /** 归属该账号的未删除对象数。 */
  objects: number;
}

export interface RoleCatalogEntry {
  key: string;
  label: string;
  isSystem: boolean;
  sortOrder: number;
  permissions: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function splitAdminSubs(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function findUserBySub(db: AppDatabase, sub: string) {
  return db.select().from(users).where(eq(users.sub, sub)).get() ?? null;
}

export function rolesForUser(db: AppDatabase, userId: string): string[] {
  return db
    .select({ roleKey: userRoles.roleKey })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all()
    .map((row) => row.roleKey);
}

export function countActiveOwners(db: AppDatabase): number {
  const row = db
    .select({ value: count() })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleKey, "owner"), eq(users.state, "active")))
    .get();

  return row?.value ?? 0;
}

function replaceUserRoles(tx: Tx, userId: string, roleKeys: readonly string[]): void {
  tx.delete(userRoles).where(eq(userRoles.userId, userId)).run();

  for (const roleKey of roleKeys) {
    tx.insert(userRoles).values({ userId, roleKey }).run();
  }
}

/**
 * 每次取会话时解析用户与权限：首次登录落 users 行，命中引导时授予 owner。
 * 写操作很轻（一条 update 或一次引导），与内容读取同一 SQLite 连接。
 */
export function resolveSessionAccess(
  db: AppDatabase,
  identity: SessionIdentity,
  options: SessionAccessOptions,
): SessionAccess {
  const now = options.now ?? nowIso();
  const existing = findUserBySub(db, identity.sub);
  const bootstrapCandidate =
    options.authMode === "mock" || splitAdminSubs(options.adminSubs).includes(identity.sub);
  const shouldBootstrap =
    options.authMode === "mock" || (countActiveOwners(db) === 0 && bootstrapCandidate);

  if (!existing) {
    const initialRoles: RoleKey[] = [shouldBootstrap ? "owner" : DEFAULT_ROLE];
    const userId = ulid();

    db.transaction((tx) => {
      tx.insert(users)
        .values({
          id: userId,
          sub: identity.sub,
          displayName: identity.name || identity.sub,
          email: identity.email,
          state: "active",
          createdAt: now,
          lastSeenAt: now,
        })
        .run();

      for (const roleKey of initialRoles) {
        tx.insert(userRoles).values({ userId, roleKey }).run();
      }

      if (shouldBootstrap) {
        writeAudit(tx, {
          actor: { sub: identity.sub, userId },
          action: "user.bootstrap",
          targetType: "user",
          targetId: userId,
          detail: { email: identity.email, roles: initialRoles },
          createdAt: now,
        });
      }
    });

    return {
      userId,
      roles: initialRoles,
      permissions: permissionsForRoles(initialRoles),
      state: "active",
    };
  }

  const currentRoles = rolesForUser(db, existing.id);
  const needsOwnership = shouldBootstrap && !currentRoles.includes("owner");

  db.transaction((tx) => {
    tx.update(users)
      .set({
        displayName: identity.name || existing.displayName,
        email: identity.email,
        lastSeenAt: now,
      })
      .where(eq(users.id, existing.id))
      .run();

    if (needsOwnership) {
      tx.insert(userRoles)
        .values({ userId: existing.id, roleKey: "owner" })
        .onConflictDoNothing()
        .run();

      writeAudit(tx, {
        actor: { sub: identity.sub, userId: existing.id },
        action: "user.bootstrap",
        targetType: "user",
        targetId: existing.id,
        detail: { reason: "no_active_owner", roles: [...currentRoles, "owner"] },
        createdAt: now,
      });
    }
  });

  const effectiveRoles = needsOwnership ? [...currentRoles, "owner"] : currentRoles;
  const active = existing.state === "active";

  return {
    userId: existing.id,
    roles: effectiveRoles,
    permissions: active ? permissionsForRoles(effectiveRoles) : [],
    state: existing.state as "active" | "disabled",
  };
}

/** 后台用户列表：users + 角色 + 名下未删除对象数。 */
export function listUsers(
  db: AppDatabase,
  query: { search?: string; state?: "active" | "disabled" } = {},
): AdminUser[] {
  const rows = db.select().from(users).all();
  const roleRows = db.select().from(userRoles).all();
  const objectRows = db
    .select({ ownerSub: objects.ownerSub, value: count() })
    .from(objects)
    .where(isNull(objects.deletedAt))
    .groupBy(objects.ownerSub)
    .all();

  const roleMap = new Map<string, string[]>();
  for (const row of roleRows) {
    const list = roleMap.get(row.userId) ?? [];
    list.push(row.roleKey);
    roleMap.set(row.userId, list);
  }

  const objectMap = new Map(objectRows.map((row) => [row.ownerSub, row.value]));
  const search = query.search?.trim().toLowerCase();

  return rows
    .filter((row) => (query.state ? row.state === query.state : true))
    .filter((row) => {
      if (!search) return true;
      return (
        row.sub.toLowerCase().includes(search)
        || row.displayName.toLowerCase().includes(search)
        || (row.email ?? "").toLowerCase().includes(search)
      );
    })
    .map((row) => ({
      id: row.id,
      sub: row.sub,
      displayName: row.displayName,
      email: row.email,
      state: row.state as AdminUser["state"],
      roles: (roleMap.get(row.id) ?? []).sort(),
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      objects: objectMap.get(row.sub) ?? 0,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface UpdateUserPatch {
  roles?: string[];
  state?: "active" | "disabled";
  sub?: string;
}

function readPatch(body: unknown): UpdateUserPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("请求体必须是 JSON 对象");
  }

  const record = body as Record<string, unknown>;
  const patch: UpdateUserPatch = {};

  if ("roles" in record) {
    if (!Array.isArray(record.roles) || record.roles.some((role) => typeof role !== "string")) {
      throw new ValidationError("roles 必须是字符串数组", { field: "roles" });
    }
    const unique = [...new Set(record.roles as string[])];
    for (const role of unique) {
      if (!isRoleKey(role)) {
        throw new ValidationError("roles 含未知角色", { field: "roles", role });
      }
    }
    patch.roles = unique;
  }

  if ("state" in record) {
    if (record.state !== "active" && record.state !== "disabled") {
      throw new ValidationError("state 取值非法", { field: "state", allowed: ["active", "disabled"] });
    }
    patch.state = record.state;
  }

  if ("sub" in record) {
    if (typeof record.sub !== "string" || record.sub.trim() === "") {
      throw new ValidationError("sub 不能为空", { field: "sub" });
    }
    patch.sub = record.sub.trim();
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError("没有可修改的字段");
  }

  return patch;
}

function sorted(roles: readonly string[]): string[] {
  return [...roles].sort();
}

/**
 * 改角色 / 停用用户。最后一个 active owner 被移除或被停用时抛
 * `CONSTRAINT_VIOLATION` + `reason=LAST_OWNER`（422），事务整体回滚。
 */
export function updateUser(
  db: AppDatabase,
  actor: ActorContext,
  userId: string,
  body: unknown,
): AdminUser {
  const patch = readPatch(body);

  if (patch.sub !== undefined && !actor.permissions.includes("role:write")) {
    throw new DomainError("FORBIDDEN", "只有所有者可以修改账号标识", { field: "sub" });
  }

  db.transaction((tx) => {
    const user = tx.select().from(users).where(eq(users.id, userId)).get();

    if (!user) {
      throw new NotFoundError("用户不存在", { id: userId });
    }

    const currentRoles = tx
      .select({ roleKey: userRoles.roleKey })
      .from(userRoles)
      .where(eq(userRoles.userId, userId))
      .all()
      .map((row) => row.roleKey);

    const nextRoles = patch.roles ?? currentRoles;
    const nextState = patch.state ?? (user.state as "active" | "disabled");
    const wasOwner = user.state === "active" && currentRoles.includes("owner");
    const willBeOwner = nextState === "active" && nextRoles.includes("owner");

    if (wasOwner && !willBeOwner) {
      const otherOwners = tx
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(and(eq(userRoles.roleKey, "owner"), eq(users.state, "active")))
        .all()
        .filter((row) => row.userId !== user.id);

      if (otherOwners.length === 0) {
        throw new DomainError("CONSTRAINT_VIOLATION", "不能移除或停用最后一个所有者", {
          reason: "LAST_OWNER",
        });
      }
    }

    if (patch.sub !== undefined && patch.sub !== user.sub) {
      const conflict = tx.select().from(users).where(eq(users.sub, patch.sub)).get();
      if (conflict && conflict.id !== user.id) {
        throw new DomainError("CONFLICT", "该账号标识已被其他用户使用", { field: "sub" });
      }
    }

    tx.update(users)
      .set({
        state: nextState,
        ...(patch.sub === undefined ? {} : { sub: patch.sub }),
      })
      .where(eq(users.id, userId))
      .run();

    if (patch.roles !== undefined && sorted(patch.roles).join("|") !== sorted(currentRoles).join("|")) {
      replaceUserRoles(tx, userId, patch.roles);
      writeAudit(tx, {
        actor,
        action: "user.roles.update",
        targetType: "user",
        targetId: userId,
        detail: { from: sorted(currentRoles), to: sorted(patch.roles) },
      });
    }

    if (patch.state !== undefined && patch.state !== user.state) {
      writeAudit(tx, {
        actor,
        action: "user.state.update",
        targetType: "user",
        targetId: userId,
        detail: { from: user.state, to: patch.state },
      });
    }

    if (patch.sub !== undefined && patch.sub !== user.sub) {
      writeAudit(tx, {
        actor,
        action: "user.sub.update",
        targetType: "user",
        targetId: userId,
        detail: { from: user.sub, to: patch.sub },
      });
    }
  });

  const refreshed = listUsers(db).find((user) => user.id === userId);

  if (!refreshed) {
    throw new NotFoundError("用户不存在", { id: userId });
  }

  return refreshed;
}

/** 角色 × 权限矩阵：读库（迁移灌入），代码常量只负责一致性校验。 */
export function listRoleCatalog(db: AppDatabase): RoleCatalogEntry[] {
  const roleRows = db.select().from(roles).all();
  const links = db.select().from(rolePermissions).all();

  const byRole = new Map<string, string[]>();
  for (const link of links) {
    const list = byRole.get(link.roleKey) ?? [];
    list.push(link.permissionKey);
    byRole.set(link.roleKey, list);
  }

  return roleRows
    .map((role) => ({
      key: role.key,
      label: role.label,
      isSystem: role.isSystem,
      sortOrder: role.sortOrder,
      permissions: byRole.get(role.key) ?? [],
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function listPermissionCatalog(db: AppDatabase) {
  return db.select().from(permissions).all().sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * 启动校验（ADR-019 风险 A7）：代码常量必须与库内目录逐项一致。
 * 不一致时拒绝静默运行——否则会出现「代码加了权限、库里没有」的判定空洞。
 */
export function assertAuthzCatalog(db: AppDatabase): void {
  const roleRows = db.select().from(roles).all();
  const permissionRows = db.select().from(permissions).all();
  const links = db.select().from(rolePermissions).all();

  const roleKeys = roleRows.map((row) => row.key).sort();
  const expectedRoles = [...ROLE_KEYS].sort();
  if (roleKeys.join("|") !== expectedRoles.join("|")) {
    throw new Error(`授权目录不一致：roles 表为 [${roleKeys}]，代码常量要求 [${expectedRoles}]`);
  }

  const permissionKeys = permissionRows.map((row) => row.key).sort();
  const expectedPermissions = PERMISSIONS.map((item) => item.key).sort();
  if (permissionKeys.join("|") !== expectedPermissions.join("|")) {
    throw new Error(
      `授权目录不一致：permissions 表与代码常量不同（库 ${permissionKeys.length} 项，代码 ${expectedPermissions.length} 项）`,
    );
  }

  for (const role of ROLES) {
    const actual = links
      .filter((link) => link.roleKey === role.key)
      .map((link) => link.permissionKey)
      .sort();
    const expected = [...ROLE_PERMISSIONS[role.key]].sort();
    if (actual.join("|") !== expected.join("|")) {
      throw new Error(`授权矩阵不一致：角色 ${role.key} 的库内权限与代码常量不同`);
    }
  }
}

/**
 * `npm run admin:grant -- <sub> <role>` 的离线恢复通道（ADR-019 第 7 条）。
 * 走同一服务层并写审计；不依赖 HTTP 与登录状态。
 */
export function grantRoleBySub(
  db: AppDatabase,
  sub: string,
  roleKey: string,
): { userId: string; created: boolean } {
  if (!isRoleKey(roleKey)) {
    throw new ValidationError("角色 key 非法", { field: "role", allowed: ROLE_KEYS });
  }

  const clean = sub.trim();
  if (!clean) {
    throw new ValidationError("sub 不能为空");
  }

  const now = nowIso();
  let created = false;
  let userId = "";

  db.transaction((tx) => {
    const existing = tx.select().from(users).where(eq(users.sub, clean)).get();

    if (existing) {
      userId = existing.id;
      tx.update(users)
        .set({ state: "active", lastSeenAt: now })
        .where(eq(users.id, existing.id))
        .run();
    } else {
      created = true;
      userId = ulid();
      tx.insert(users)
        .values({
          id: userId,
          sub: clean,
          displayName: clean,
          email: null,
          state: "active",
          createdAt: now,
          lastSeenAt: now,
        })
        .run();
      tx.insert(userRoles).values({ userId, roleKey }).run();
    }

    tx.insert(userRoles).values({ userId, roleKey }).onConflictDoNothing().run();

    writeAudit(tx, {
      actor: { sub: "cli:admin-grant", userId: null },
      action: "user.bootstrap",
      targetType: "user",
      targetId: userId,
      detail: { sub: clean, role: roleKey, source: "admin:grant", created },
      createdAt: now,
    });
  });

  return { userId, created };
}
