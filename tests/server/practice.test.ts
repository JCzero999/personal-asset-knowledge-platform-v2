import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { VALUE_DIMENSION_KEYS } from "../../src/domain/value";
import type { BusinessObject } from "../../src/domain/objects";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { practiceWork } from "../../src/server/services/asset-service";
import type { AiChatFn } from "../../src/server/services/asset-ai";
import { actor } from "../helpers/actor";
import { seedTag } from "../helpers/seed";

/**
 * 实践结算（规格 v2.0 第 5、7 节）：
 * 外库 published 作品 → 单事务建内库资产 + 5 维评估 + 作品 practiced（不归档）。
 * 重点是「一损俱损」：任何一步失败都不能留下「已实践但没沉淀」的中间态。
 */

function chat(options: { value?: number; valueError?: boolean } = {}): AiChatFn {
  return async () => {
    if (options.valueError) throw new Error("模型连接失败");
    const value = options.value ?? 4;
    return JSON.stringify({
      dimensions: VALUE_DIMENSION_KEYS.map((key) => ({ key, score: value, reason: "理由" })),
    });
  };
}

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
  seedTag(handle, "复盘");
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec(`
    DELETE FROM sync_jobs;
    DELETE FROM library_events;
    DELETE FROM content_refs;
    DELETE FROM audit_events;
    DELETE FROM objects;
  `);
  repo = new SqliteObjectRepository(handle.db);
});

async function publishedWork(title = "如何做一门课"): Promise<BusinessObject> {
  const work = await repo.create({
    type: "work",
    title,
    description: "从选题到交付的完整流程",
    library: "external",
    category: "course",
    priority: "high",
    tags: ["复盘"],
    ownerSub: "u1",
  });

  await repo.changeStatus({ objectId: work.id, to: "finished" });
  return repo.changeStatus({ objectId: work.id, to: "published" });
}

describe("practiceWork", () => {
  it("published 作品：原子沉淀内库资产，作品保留可查且不归档", async () => {
    const work = await publishedWork();
    const metrics = { costHours: 6, students: 120, rating: 4.7 };

    const settled = await practiceWork(
      handle.db,
      actor("u1"),
      work.id,
      { metrics },
      { chat: chat({ value: 4 }) },
    );

    expect(settled.work).toMatchObject({
      id: work.id,
      type: "work",
      status: "practiced",
      library: "external",
      practiceMetrics: metrics,
      settledAssetId: settled.asset.id,
    });
    expect(settled.work.practicedAt).not.toBeNull();
    // practiced 是正常终态，不自动归档：作品要留在默认视图里可查。
    expect(settled.work.archivedAt).toBeNull();
    expect(settled.work.revision).toBe(work.revision + 1);

    // 默认列表（排除归档）与词法检索都能找到它。
    const listed = await repo.list({ ownerSub: "u1" });
    expect(listed.map((item) => item.id)).toContain(work.id);

    const lexical = await repo.lexicalSearch({
      ownerSub: "u1",
      terms: [{ field: "title", value: "如何做一门课", negated: false }],
    });
    expect(lexical.candidates.map((candidate) => candidate.object.id)).toContain(work.id);

    expect(settled.asset).toMatchObject({
      type: "asset",
      library: "internal",
      sourceType: "practiced_work",
      originWorkId: work.id,
      aiStatus: "approved",
      title: work.title,
      description: work.description,
      category: "course",
      priority: "high",
      tags: ["复盘"],
    });
    // 5 维全 4 分 → 20 分 → A 级
    expect(settled.asset.valueLevel).toBe("A");
    expect(settled.asset.valueScores?.source).toBe("model");

    const reloaded = await repo.findById(work.id);
    expect(reloaded?.settledAssetId).toBe(settled.asset.id);
  });

  it("模型不可用：退回确定性兜底（C 级），结算照常完成", async () => {
    const work = await publishedWork("模型抖动");

    const settled = await practiceWork(
      handle.db,
      actor("u1"),
      work.id,
      {},
      { chat: chat({ valueError: true }) },
    );

    expect(settled.work.status).toBe("practiced");
    expect(settled.asset.library).toBe("internal");
    expect(settled.asset.valueLevel).toBe("C");
    expect(settled.asset.valueScores?.source).toBe("fallback");
  });

  it("未发布的作品不能结算", async () => {
    const work = await repo.create({
      type: "work",
      title: "草稿",
      library: "external",
      category: "course",
      ownerSub: "u1",
    });

    await expect(
      practiceWork(handle.db, actor("u1"), work.id, {}, { chat: chat() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await repo.findById(work.id))?.status).toBe("draft");
  });

  it("重复结算被拒绝：一个作品最多沉淀一次", async () => {
    const work = await publishedWork("只能结算一次");
    const settled = await practiceWork(handle.db, actor("u1"), work.id, {}, { chat: chat() });

    await expect(
      practiceWork(handle.db, actor("u1"), work.id, {}, { chat: chat() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(settled.asset.originWorkId).toBe(work.id);
  });

  it("只有作品可以结算", async () => {
    const asset = await repo.create({
      type: "asset",
      title: "资产",
      library: "internal",
      ownerSub: "u1",
    });

    await expect(
      practiceWork(handle.db, actor("u1"), asset.id, {}, { chat: chat() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("乐观锁不一致：整个结算不落库", async () => {
    const work = await publishedWork("版本冲突");

    await expect(
      practiceWork(
        handle.db,
        actor("u1"),
        work.id,
        { expectedRevision: 99 },
        { chat: chat() },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const after = await repo.findById(work.id);
    expect(after).toMatchObject({ status: "published", settledAssetId: null, practicedAt: null });
    expect(await repo.list({ type: "asset" })).toHaveLength(0);
  });

  it("事务内失败整体回滚：作品的任何一行都不动", async () => {
    const work = await publishedWork("事务回滚");

    // 抢占 origin_work 唯一键：结算插入资产时会违反唯一索引，事务必须整体回滚。
    await repo.create({
      type: "asset",
      title: "占位资产",
      library: "internal",
      ownerSub: "u1",
      sourceType: "practiced_work",
      originWorkId: work.id,
    });

    await expect(
      practiceWork(handle.db, actor("u1"), work.id, {}, { chat: chat() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const after = await repo.findById(work.id);
    expect(after).toMatchObject({
      status: "published",
      settledAssetId: null,
      practicedAt: null,
      practiceMetrics: null,
      archivedAt: null,
      revision: work.revision,
    });

    const assets = await repo.list({ type: "asset" });
    expect(assets).toHaveLength(1);
    expect(assets[0].title).toBe("占位资产");
  });

  it("他人的作品按不存在处理", async () => {
    const work = await publishedWork("别人的作品");

    await expect(
      practiceWork(handle.db, actor("u2"), work.id, {}, { chat: chat() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("结算时写入正文快照：整篇 sha256 + 前 2000 字", async () => {
    const work = await publishedWork("快照");
    const content = "复盘三步法：事实与判断分开记录，单点归因，写成下一次动作。".repeat(120);

    const settled = await practiceWork(
      handle.db,
      actor("u1"),
      work.id,
      {},
      { chat: chat(), readContent: async () => content },
    );

    expect(settled.asset.contentHash).toBe(
      createHash("sha256").update(content, "utf8").digest("hex"),
    );
    expect(settled.asset.contentSnapshot).toBe(content.slice(0, 2_000));
    expect(Array.from(settled.asset.contentSnapshot ?? "")).toHaveLength(2_000);
    expect(settled.asset.contentSnapshotAt).not.toBeNull();
  });

  it("读正文失败不阻塞结算：资产照常沉淀，写一条失败审计", async () => {
    const work = await publishedWork("读不到正文");

    const settled = await practiceWork(
      handle.db,
      actor("u1"),
      work.id,
      {},
      {
        chat: chat(),
        readContent: async () => {
          throw new Error("RAGFlow 超时");
        },
      },
    );

    expect(settled.work.status).toBe("practiced");
    expect(settled.asset.library).toBe("internal");
    expect(settled.asset.contentHash).toBeNull();
    expect(settled.asset.contentSnapshot).toBeNull();

    const audit = handle.sqlite
      .prepare(
        "select action, result, target_id from audit_events where action = 'value.snapshot_failed'",
      )
      .all() as { action: string; result: string; target_id: string }[];
    expect(audit).toEqual([
      { action: "value.snapshot_failed", result: "error", target_id: work.id },
    ]);
  });
});
