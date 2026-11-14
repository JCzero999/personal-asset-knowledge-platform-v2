import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { computeIsAdmin, parseAdminSubs } from "../../src/server/roles";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { contentRefs, objects, syncJobs } from "../../src/server/db/schema";
import { loadAdminOverview } from "../../src/server/services/admin-service";

/**
 * 管理后台统计的回归测试：计数口径一旦写错，
 * 后台会安静地显示错误的健康度，所以用内存库钉死。
 */

let handle: DatabaseHandle;

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec(`
    DELETE FROM content_refs;
    DELETE FROM sync_jobs;
    DELETE FROM objects;
  `);
});

const base = { createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z" };

function insertObject(
  id: string,
  overrides: Partial<typeof objects.$inferInsert> = {},
) {
  const row: typeof objects.$inferInsert = {
    id,
    type: "asset",
    title: id,
    library: "internal",
    source: "handwritten",
    origin: "self",
    priority: "medium",
    ownerSub: "owner-a",
    ...base,
    ...overrides,
  };

  // 规则 4（ADR-029）：内库资产必须有 5 维分与等级，直写也不能绕开。
  if (row.type === "asset" && row.library === "internal") {
    row.valueLevel ??= "C";
    row.valueScores ??= JSON.stringify({
      dimensions: [],
      average: 2,
      level: "C",
      source: "fallback",
      assessedAt: base.createdAt,
    });
    row.valueAssessedAt ??= base.createdAt;
  }

  handle.db.insert(objects).values(row).run();
}

describe("loadAdminOverview", () => {
  it("按类型、库别、归档与软删分别计数，并忽略已删除的内容引用", () => {
    insertObject("asset-1");
    insertObject("work-1", {
      type: "work",
      library: "external",
      categoryCode: "article",
      status: "draft",
    });
    insertObject("asset-2", { library: "external", ownerSub: "owner-b" });
    insertObject("asset-3", { deletedAt: "2026-11-11T11:00:00.000Z" });
    insertObject("asset-4", { archivedAt: "2026-11-11T11:00:00.000Z" });

    handle.db
      .insert(contentRefs)
      .values([
        {
          id: "ref-1",
          ownerType: "asset",
          ownerId: "asset-1",
          provider: "ragflow",
          datasetId: "ds",
          documentId: "doc-1",
          contentKey: "obj:asset-1:primary",
          role: "primary",
          parseStatus: "succeeded",
          syncState: "synced",
          ...base,
        },
        {
          id: "ref-2",
          ownerType: "asset",
          ownerId: "asset-1",
          provider: "ragflow",
          datasetId: "ds",
          documentId: "doc-2",
          contentKey: "obj:asset-1:att:1",
          role: "attachment",
          parseStatus: "failed",
          syncState: "sync_failed",
          ...base,
        },
        {
          id: "ref-3",
          ownerType: "asset",
          ownerId: "asset-1",
          provider: "ragflow",
          datasetId: "ds",
          documentId: "doc-3",
          contentKey: "obj:asset-1:att:2",
          role: "attachment",
          parseStatus: "succeeded",
          syncState: "synced",
          deletedAt: "2026-11-11T11:00:00.000Z",
          ...base,
        },
      ])
      .run();

    handle.db
      .insert(syncJobs)
      .values([
        {
          id: "job-1",
          ownerType: "asset",
          ownerId: "asset-1",
          action: "upsert",
          state: "pending",
          availableAt: base.createdAt,
          ...base,
        },
        {
          id: "job-2",
          ownerType: "asset",
          ownerId: "asset-1",
          action: "upsert",
          state: "failed",
          availableAt: base.createdAt,
          ...base,
        },
      ])
      .run();

    const overview = loadAdminOverview(handle.db);

    expect(overview.objects).toMatchObject({
      total: 4,
      assets: 3,
      works: 1,
      internal: 2,
      external: 2,
      archived: 1,
      deleted: 1,
    });
    expect(overview.content).toMatchObject({
      total: 2,
      primary: 1,
      attachment: 1,
      parseFailed: 1,
      syncFailed: 1,
    });
    expect(overview.jobs).toMatchObject({ pending: 1, failed: 1, done: 0, running: 0 });
    expect(overview.owners).toHaveLength(2);

    const ownerA = overview.owners.find((owner) => owner.ownerSub === "owner-a");
    expect(ownerA).toMatchObject({ objects: 3, works: 1 });
  });
});

describe("computeIsAdmin", () => {
  it("解析逗号与空白分隔的白名单", () => {
    expect(parseAdminSubs(" a, b  c\n d ")).toEqual(["a", "b", "c", "d"]);
    expect(parseAdminSubs(undefined)).toEqual([]);
  });

  it("logto 模式只看白名单，mock 模式恒为管理员", () => {
    expect(
      computeIsAdmin({ sub: "u1", authMode: "logto", adminSubs: "u1,u2" }),
    ).toBe(true);
    expect(
      computeIsAdmin({ sub: "u3", authMode: "logto", adminSubs: "u1,u2" }),
    ).toBe(false);
    expect(computeIsAdmin({ sub: "u3", authMode: "logto", adminSubs: "" })).toBe(false);
    expect(
      computeIsAdmin({ sub: "u3", authMode: "mock", adminSubs: "" }),
    ).toBe(true);
  });
});
