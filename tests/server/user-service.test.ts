import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomainError, ValidationError } from "../../src/domain/errors";
import { PERMISSION_KEYS, ROLE_PERMISSIONS, permissionsForRoles } from "../../src/server/authz";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { auditEvents } from "../../src/server/db/schema";
import {
  assertAuthzCatalog,
  countActiveOwners,
  grantRoleBySub,
  listPermissionCatalog,
  listRoleCatalog,
  listUsers,
  resolveSessionAccess,
  updateUser,
} from "../../src/server/services/user-service";
import type { ActorContext } from "../../src/server/authz";

/**
 * 用户与引导测试（ADR-019）：ADMIN_SUBS 只在「没有 active owner」时生效、
 * 最后一个 owner 受保护、离线恢复通道、角色矩阵与代码常量一致。
 */

const OWNER_SUB = "gdv8t04dw4ca";

const ownerActor: ActorContext = {
  sub: OWNER_SUB,
  userId: null,
  permissions: ["user:read", "user:write", "role:write"],
};

const identity = (sub: string, name = sub) => ({ sub, name, email: `${sub}@example.com` });

/** 测试里拿到的一定是已建档账号；null 只可能出现在停用返回。 */
function userIdOf(access: { userId: string | null }): string {
  if (!access.userId) throw new Error("会话没有 userId");
  return access.userId;
}

function login(
  handle: DatabaseHandle,
  sub: string,
  options: { authMode?: "mock" | "logto" | "disabled"; adminSubs?: string } = {},
) {
  return resolveSessionAccess(handle.db, identity(sub), {
    authMode: options.authMode ?? "logto",
    adminSubs: options.adminSubs ?? OWNER_SUB,
    now: "2026-11-12T00:00:00.000Z",
  });
}

describe("会话引导（ADR-019）", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = openDatabase({ file: ":memory:" });
  });

  afterEach(() => {
    handle.close();
  });

  it("没有 active owner 时，ADMIN_SUBS 里的第一个登录者成为 owner", () => {
    const access = login(handle, OWNER_SUB);

    expect(access.roles).toEqual(["owner"]);
    expect(access.permissions).toEqual(permissionsForRoles(["owner"]));
    expect(countActiveOwners(handle.db)).toBe(1);

    const audit = handle.db.select().from(auditEvents).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "user.bootstrap", actorSub: OWNER_SUB });
  });

  it("已有 owner 后，ADMIN_SUBS 不再授予新的 owner", () => {
    login(handle, OWNER_SUB);
    const second = login(handle, "someone-else");

    expect(second.roles).toEqual(["viewer"]);
    expect(second.permissions).toEqual(["object:read"]);
    expect(countActiveOwners(handle.db)).toBe(1);
  });

  it("已有 owner 后清空 ADMIN_SUBS，owner 仍能登录并获得全部权限", () => {
    login(handle, OWNER_SUB);
    const again = login(handle, OWNER_SUB, { adminSubs: "" });

    expect(again.roles).toEqual(["owner"]);
    expect(again.permissions).toEqual(permissionsForRoles(["owner"]));
  });

  it("ADMIN_SUBS 未包含自己时，陌生账号默认只读", () => {
    const access = login(handle, "stranger", { adminSubs: "not-me" });

    expect(access.roles).toEqual(["viewer"]);
  });

  it("mock 模式固定是 owner，且在已有 owner 时也补齐 owner 角色", () => {
    login(handle, OWNER_SUB);
    const mock = login(handle, "mock-user", { authMode: "mock", adminSubs: undefined });

    expect(mock.roles).toContain("owner");
    expect(mock.permissions).toEqual(permissionsForRoles(["owner"]));
  });

  it("停用账号登录不获得任何权限", () => {
    login(handle, OWNER_SUB);
    const other = login(handle, "reader");
    updateUser(handle.db, ownerActor, userIdOf(other), { state: "disabled" });

    const disabled = login(handle, "reader");

    expect(disabled.permissions).toEqual([]);
    expect(disabled.state).toBe("disabled");
  });

  it("所有 owner 都丢失后，ADMIN_SUBS 可以重新引导一个 owner", () => {
    const first = login(handle, OWNER_SUB);
    // 直接改库模拟历史数据损坏：没有 active owner。
    handle.sqlite.prepare("update user_roles set role_key = 'viewer' where user_id = ?").run(first.userId);

    const recovered = login(handle, "recover-me", { adminSubs: "recover-me" });

    expect(recovered.roles).toEqual(["owner"]);
    expect(countActiveOwners(handle.db)).toBe(1);
  });
});

describe("updateUser：最后一个 owner 受保护", () => {
  let handle: DatabaseHandle;
  let ownerId: string;

  beforeEach(() => {
    handle = openDatabase({ file: ":memory:" });
    ownerId = userIdOf(login(handle, OWNER_SUB));
  });

  afterEach(() => {
    handle.close();
  });

  it("移除最后一个 owner 的角色被拒绝，角色与审计都不变", () => {
    try {
      updateUser(handle.db, ownerActor, ownerId, { roles: ["viewer"] });
      expect.unreachable("应当拒绝移除最后一个所有者");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("CONSTRAINT_VIOLATION");
      expect((error as DomainError).details).toMatchObject({ reason: "LAST_OWNER" });
    }

    const user = listUsers(handle.db).find((item) => item.id === ownerId);
    expect(user?.roles).toEqual(["owner"]);
    expect(handle.db.select().from(auditEvents).all()).toHaveLength(1); // 只有 bootstarp 那条
  });

  it("停用最后一个 owner 同样被拒绝", () => {
    expect(() =>
      updateUser(handle.db, ownerActor, ownerId, { state: "disabled" }),
    ).toThrowError(/最后一个所有者/);

    expect(listUsers(handle.db).find((item) => item.id === ownerId)?.state).toBe("active");
  });

  it("有第二个 owner 时，降级被允许并写审计", () => {
    const second = login(handle, "second-owner");
    updateUser(handle.db, ownerActor, userIdOf(second), { roles: ["owner"] });

    const updated = updateUser(handle.db, ownerActor, userIdOf(second), { roles: ["admin"] });

    expect(updated.roles).toEqual(["admin"]);
    const audit = handle.db.select().from(auditEvents).all();
    const rolesAudit = audit.filter((row) => row.action === "user.roles.update");
    expect(rolesAudit).toHaveLength(2);
    expect(JSON.parse(rolesAudit[1].detail ?? "{}")).toEqual({
      from: ["owner"],
      to: ["admin"],
    });
  });

  it("未知角色被拒绝，且不写任何审计", () => {
    expect(() =>
      updateUser(handle.db, ownerActor, ownerId, { roles: ["root"] }),
    ).toThrowError(ValidationError);
  });

  it("改 sub 需要 role:write", () => {
    const adminOnly: ActorContext = {
      sub: "admin-user",
      userId: null,
      permissions: ["user:read", "user:write"],
    };

    expect(() =>
      updateUser(handle.db, adminOnly, ownerId, { sub: "new-sub" }),
    ).toThrowError(/只有所有者/);
  });
});

describe("离线恢复与目录一致性", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = openDatabase({ file: ":memory:" });
  });

  afterEach(() => {
    handle.close();
  });

  it("grantRoleBySub 创建用户、赋角色并写 bootstrap 审计", () => {
    const result = grantRoleBySub(handle.db, OWNER_SUB, "owner");

    expect(result.created).toBe(true);
    const user = listUsers(handle.db).find((item) => item.id === result.userId);
    expect(user?.roles).toEqual(["owner"]);
    expect(user?.state).toBe("active");

    const [audit] = handle.db.select().from(auditEvents).all();
    expect(audit).toMatchObject({
      action: "user.bootstrap",
      actorSub: "cli:admin-grant",
      targetId: result.userId,
    });
  });

  it("grantRoleBySub 对未知角色报 ValidationError", () => {
    expect(() => grantRoleBySub(handle.db, OWNER_SUB, "root")).toThrowError(ValidationError);
  });

  it("库里的角色矩阵与代码常量逐格一致", () => {
    assertAuthzCatalog(handle.db);

    const catalog = listRoleCatalog(handle.db);
    for (const role of catalog) {
      expect(new Set(role.permissions)).toEqual(
        new Set(ROLE_PERMISSIONS[role.key as keyof typeof ROLE_PERMISSIONS]),
      );
    }
  });

  it("库里的权限清单与代码常量一致（13 项）", () => {
    const permissions = listPermissionCatalog(handle.db);
    expect(permissions.map((item) => item.key)).toEqual([...PERMISSION_KEYS]);
  });
});
