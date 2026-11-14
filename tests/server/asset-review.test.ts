import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AI_DIMENSIONS, VALUE_DIMENSION_KEYS } from "../../src/domain/value";
import type { BusinessObject } from "../../src/domain/objects";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { reviewAsset, scoreExternalAsset } from "../../src/server/services/asset-service";
import type { AiChatFn } from "../../src/server/services/asset-ai";
import { actor } from "../helpers/actor";

/**
 * 人工复核（规格 v2.0 第 4.2 节）：只有「待人工复核」的资产可以复核。
 * approve → 内库 + 5 维评估 + approved；reject → 低价值外库。
 */

function chat(options: { value?: number; valueError?: boolean } = {}): AiChatFn {
  return async (request) => {
    if (request.system.includes("5 维价值评估")) {
      if (options.valueError) throw new Error("模型连接失败");
      const value = options.value ?? 4;
      return JSON.stringify({
        dimensions: VALUE_DIMENSION_KEYS.map((key) => ({ key, score: value, reason: "理由" })),
      });
    }

    // 打分统一给 70 → needs_review，进入人工复核池。
    return JSON.stringify({
      dimensions: AI_DIMENSIONS.map((dimension) => ({
        key: dimension.key,
        score: 70,
        reason: "理由",
      })),
    });
  };
}

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
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

async function needsReviewAsset(title = "待复核资产"): Promise<BusinessObject> {
  const asset = await repo.create({
    type: "asset",
    title,
    library: "external",
    ownerSub: "u1",
    source: "ai_extracted",
    sourceType: "ai_extract",
  });

  return scoreExternalAsset(handle.db, actor("u1"), asset.id, { chat: chat() });
}

describe("reviewAsset", () => {
  it("approve：转内库、完成 5 维评估、记为 approved，并留下复核痕迹", async () => {
    const asset = await needsReviewAsset();
    expect(asset.aiStatus).toBe("needs_review");

    const reviewed = await reviewAsset(
      handle.db,
      actor("u1"),
      asset.id,
      { decision: "approve", note: "补充了可执行清单" },
      { chat: chat({ value: 5 }) },
    );

    expect(reviewed.aiStatus).toBe("approved");
    expect(reviewed.library).toBe("internal");
    expect(reviewed.valueLevel).toBe("S");
    expect(reviewed.valueScores?.source).toBe("model");
    expect(reviewed.aiScoreDetail?.review).toMatchObject({
      decision: "approve",
      note: "补充了可执行清单",
      actorSub: "u1",
    });

    const events = await repo.listLibraryEvents(asset.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromLibrary: "external", toLibrary: "internal" });
  });

  it("reject：留在外库，记为低价值，复核痕迹保留", async () => {
    const asset = await needsReviewAsset("被拒资产");

    const reviewed = await reviewAsset(handle.db, actor("u1"), asset.id, {
      decision: "reject",
      note: "与已有资产重复",
    });

    expect(reviewed.aiStatus).toBe("low_value");
    expect(reviewed.library).toBe("external");
    expect(reviewed.valueLevel).toBeNull();
    expect(reviewed.aiScoreDetail?.review).toMatchObject({
      decision: "reject",
      note: "与已有资产重复",
    });
    expect(await repo.listLibraryEvents(asset.id)).toHaveLength(0);
  });

  it("approve 时模型失败：退回确定性兜底（C 级）仍然批准入库", async () => {
    const asset = await needsReviewAsset("兜底批准");

    const reviewed = await reviewAsset(
      handle.db,
      actor("u1"),
      asset.id,
      { decision: "approve" },
      { chat: chat({ valueError: true }) },
    );

    expect(reviewed.library).toBe("internal");
    expect(reviewed.aiStatus).toBe("approved");
    expect(reviewed.valueLevel).toBe("C");
    expect(reviewed.valueScores?.source).toBe("fallback");
  });

  it("只有待复核资产可以复核：未评分 / 已通过 / 已拒绝都拒绝", async () => {
    const unscored = await repo.create({
      type: "asset",
      title: "未评分",
      library: "external",
      ownerSub: "u1",
    });

    await expect(
      reviewAsset(handle.db, actor("u1"), unscored.id, { decision: "approve" }, { chat: chat() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const approved = await needsReviewAsset("已通过");
    await reviewAsset(handle.db, actor("u1"), approved.id, { decision: "approve" }, { chat: chat() });

    await expect(
      reviewAsset(handle.db, actor("u1"), approved.id, { decision: "reject" }, { chat: chat() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("decision 与 note 的入参校验", async () => {
    const asset = await needsReviewAsset();

    await expect(
      reviewAsset(handle.db, actor("u1"), asset.id, { decision: "maybe" }, { chat: chat() }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await expect(
      reviewAsset(
        handle.db,
        actor("u1"),
        asset.id,
        { decision: "approve", note: "字".repeat(501) },
        { chat: chat() },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("复核同样按 ownerSub 隔离，作品与内库资产不允许复核", async () => {
    const asset = await needsReviewAsset();

    await expect(
      reviewAsset(handle.db, actor("u2"), asset.id, { decision: "approve" }, { chat: chat() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const internal = await repo.create({
      type: "asset",
      title: "内库资产",
      library: "internal",
      ownerSub: "u1",
      valueLevel: "B",
    });

    await expect(
      reviewAsset(handle.db, actor("u1"), internal.id, { decision: "approve" }, { chat: chat() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
