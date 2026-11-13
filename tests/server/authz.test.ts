import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  PERMISSIONS,
  PERMISSION_KEYS,
  ROLES,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  hasPermission,
  permissionsForRoles,
  requirePermissionWith,
  toActor,
  type PermissionKey,
} from "../../src/server/authz";
import { auditEvents } from "../../src/server/db/schema";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import type { Session } from "../../src/server/ports/session";

/**
 * 授权层测试（ADR-019）：角色 × 权限矩阵逐格核对，以及唯一强制层
 * `requirePermission` 的 401 / 403 / 拒绝审计 / 审计失败不放行。
 */

/** ADR-019 的表格，故意写成独立常量：代码常量改了而这里没改就会失败。 */
const ADR_MATRIX: Record<string, PermissionKey[]> = {
  owner: [...PERMISSION_KEYS],
  admin: PERMISSION_KEYS.filter((key) => key !== "user:write" && key !== "role:write"),
  editor: ["object:read", "object:write"],
  viewer: ["object:read"],
};

function sessionWith(permissions: string[], overrides: Partial<Session> = {}): Session {
  return {
    sub: "gdv8t04dw4ca",
    name: "测试用户",
    email: null,
    userId: "user-1",
    permissions,
    isAdmin: false,
    ...overrides,
  };
}

describe("角色 → 权限矩阵（ADR-019）", () => {
  it("登记 15 项权限，key 唯一且顺序稳定", () => {
    expect(PERMISSIONS).toHaveLength(15);
    expect(new Set(PERMISSION_KEYS).size).toBe(15);
    expect(PERMISSION_KEYS).toEqual(PERMISSIONS.map((item) => item.key));
  });

  it("四个系统角色与 ADR 一致", () => {
    expect([...ROLE_KEYS]).toEqual(["owner", "admin", "editor", "viewer"]);
    expect(ROLES.map((role) => role.label)).toEqual(["所有者", "管理员", "编辑", "只读"]);
  });

  /** 60 格逐一断言，避免「看起来对」但漏掉一格。 */
  const cells = ROLE_KEYS.flatMap((role) =>
    PERMISSION_KEYS.map((permission) => [role, permission] as const),
  );

  it("矩阵共 60 格", () => {
    expect(cells).toHaveLength(60);
  });

  it.each(cells)("%s × %s 与 ADR 表格一致", (role, permission) => {
    const expected = ADR_MATRIX[role].includes(permission);
    expect(ROLE_PERMISSIONS[role].includes(permission)).toBe(expected);
  });

  it("未知角色不获得任何权限", () => {
    expect(permissionsForRoles(["ghost"])).toEqual([]);
  });

  it("多角色取并集并按权限清单顺序输出", () => {
    expect(permissionsForRoles(["viewer", "editor"])).toEqual([
      "object:read",
      "object:write",
    ]);
    expect(permissionsForRoles(["admin", "owner"])).toEqual([...PERMISSION_KEYS]);
  });

  it("hasPermission 对空会话返回 false", () => {
    expect(hasPermission(null, "object:read")).toBe(false);
    expect(hasPermission({ permissions: [] }, "object:read")).toBe(false);
    expect(hasPermission({ permissions: ["object:read"] }, "object:read")).toBe(true);
  });

  it("toActor 只带走身份与权限快照", () => {
    expect(toActor(sessionWith(["object:read"]))).toEqual({
      sub: "gdv8t04dw4ca",
      userId: "user-1",
      permissions: ["object:read"],
    });
  });
});

describe("requirePermissionWith（唯一强制层）", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = openDatabase({ file: ":memory:" });
  });

  afterEach(() => {
    handle.close();
  });

  it("未登录返回 401，不写审计", async () => {
    const response = requirePermissionWith(handle.db, null, "object:read");

    expect(response?.status).toBe(401);
    const body = await response!.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(handle.db.select().from(auditEvents).all()).toHaveLength(0);
  });

  it("有权限时放行（返回 null）", () => {
    const response = requirePermissionWith(
      handle.db,
      sessionWith(["object:read"]),
      "object:read",
    );

    expect(response).toBeNull();
    expect(handle.db.select().from(auditEvents).all()).toHaveLength(0);
  });

  it("无权限返回 403，并独立写一条 denied 审计", async () => {
    const response = requirePermissionWith(
      handle.db,
      sessionWith(["object:read"]),
      "object:write",
    );

    expect(response?.status).toBe(403);
    const body = await response!.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.details).toMatchObject({ permission: "object:write" });

    const rows = handle.db.select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorSub: "gdv8t04dw4ca",
      actorUserId: "user-1",
      action: "authz.denied",
      targetType: "permission",
      targetId: "object:write",
      result: "denied",
    });
    expect(JSON.parse(rows[0].detail ?? "{}")).toEqual({ permission: "object:write" });
  });

  it("审计写不进去时仍然拒绝，绝不放行", () => {
    const brokenDb = {
      insert() {
        throw new Error("disk full");
      },
    } as unknown as Parameters<typeof requirePermissionWith>[0];

    const response = requirePermissionWith(
      brokenDb,
      sessionWith([]),
      "object:delete",
    );

    expect(response?.status).toBe(403);
  });

  it("denied 记录按被拒时间追加，不覆盖已有审计", () => {
    requirePermissionWith(handle.db, sessionWith([]), "object:write");
    requirePermissionWith(handle.db, sessionWith([]), "object:delete");

    const rows = handle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "authz.denied"))
      .all();

    expect(rows.map((row) => row.targetId).sort()).toEqual(["object:delete", "object:write"]);
  });
});
