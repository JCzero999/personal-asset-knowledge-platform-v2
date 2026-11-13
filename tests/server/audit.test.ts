import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { actor } from "../helpers/actor";
import { AUDIT_ACTIONS, listAuditEvents, recordDeniedAudit, writeAudit } from "../../src/server/services/audit-service";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { auditEvents } from "../../src/server/db/schema";
import { createObject, deleteObject } from "../../src/server/services/object-service";

/**
 * 审计测试（ADR-019）：业务写与审计同事务提交/回滚、拒绝记录独立写入、
 * 游标分页与筛选。
 */

const AUDIT_ACTOR = { sub: "gdv8t04dw4ca", userId: null };

describe("audit-events", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = openDatabase({ file: ":memory:" });
  });

  afterEach(() => {
    handle.close();
  });

  it("业务写与审计同事务：成功时两边都落库", async () => {
    const object = await createObject(handle.db, actor("gdv8t04dw4ca"), {
      type: "asset",
      title: "待删除资产",
      library: "internal",
    });

    await deleteObject(handle.db, actor("gdv8t04dw4ca"), object.id);

    const rows = handle.db.select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "object.delete",
      targetType: "object",
      targetId: object.id,
      result: "ok",
    });
  });

  it("同事务内抛错时业务写与审计一起回滚", () => {
    expect(() =>
      handle.db.transaction((tx) => {
        writeAudit(tx, { actor: AUDIT_ACTOR, action: "object.archive", targetId: "x" });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(handle.db.select().from(auditEvents).all()).toHaveLength(0);
  });

  it("写审计失败会让外层事务回滚（业务写不落地）", async () => {
    const object = await createObject(handle.db, actor("gdv8t04dw4ca"), {
      type: "asset",
      title: "审计失败样例",
      library: "internal",
    });

    // 让审计写入失败：只读触发器不是长久之计，这里直接删掉审计表模拟故障。
    handle.sqlite.exec("DROP TABLE audit_events");

    await expect(
      deleteObject(handle.db, actor("gdv8t04dw4ca"), object.id),
    ).rejects.toThrow();

    const stillThere = handle.sqlite
      .prepare("select deleted_at from objects where id = ?")
      .get(object.id) as { deleted_at: string | null };
    expect(stillThere.deleted_at).toBeNull();
  });

  it("记录拒绝时带上权限与结果 denied", () => {
    recordDeniedAudit(handle.db, AUDIT_ACTOR, "object:write");

    const [row] = handle.db.select().from(auditEvents).all();
    expect(row).toMatchObject({
      action: "authz.denied",
      actorSub: "gdv8t04dw4ca",
      targetType: "permission",
      targetId: "object:write",
      result: "denied",
    });
  });

  it("审计动作清单覆盖业务写与账号维护", () => {
    expect(AUDIT_ACTIONS).toContain("object.delete");
    expect(AUDIT_ACTIONS).toContain("vocabulary.tag.merge");
    expect(AUDIT_ACTIONS).toContain("user.roles.update");
    expect(AUDIT_ACTIONS).toContain("user.sub.update");
    expect(AUDIT_ACTIONS).toContain("authz.denied");
  });

  it("按时间与 id 倒序返回，游标翻页不重不漏", () => {
    const base = Date.parse("2026-11-01T00:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      writeAudit(handle.db, {
        actor: AUDIT_ACTOR,
        action: "object.archive",
        targetId: `o-${index}`,
        createdAt: new Date(base + index * 1000).toISOString(),
      });
    }

    const first = listAuditEvents(handle.db, { limit: 2 });
    expect(first.items.map((item) => item.targetId)).toEqual(["o-4", "o-3"]);
    expect(first.nextCursor).not.toBeNull();

    const second = listAuditEvents(handle.db, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((item) => item.targetId)).toEqual(["o-2", "o-1"]);

    const third = listAuditEvents(handle.db, { limit: 2, cursor: second.nextCursor ?? undefined });
    expect(third.items.map((item) => item.targetId)).toEqual(["o-0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("可按 action / result / actor 筛选", () => {
    writeAudit(handle.db, { actor: AUDIT_ACTOR, action: "object.archive", targetId: "a" });
    writeAudit(handle.db, { actor: { sub: "other", userId: null }, action: "object.delete", targetId: "b" });
    recordDeniedAudit(handle.db, AUDIT_ACTOR, "user:write");

    expect(
      listAuditEvents(handle.db, { action: "object.archive" }).items.map((item) => item.targetId),
    ).toEqual(["a"]);
    expect(listAuditEvents(handle.db, { actorSub: "other" }).items).toHaveLength(1);
    expect(listAuditEvents(handle.db, { result: "denied" }).items).toHaveLength(1);
  });

  it("limit 被夹在 1~200 之间", () => {
    for (let index = 0; index < 3; index += 1) {
      writeAudit(handle.db, { actor: AUDIT_ACTOR, action: "object.archive", targetId: `o-${index}` });
    }

    expect(listAuditEvents(handle.db, { limit: 0 }).items).toHaveLength(1);
    expect(listAuditEvents(handle.db, { limit: 500 }).items).toHaveLength(3);
  });
});
