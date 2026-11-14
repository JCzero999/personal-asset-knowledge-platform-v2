import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AI_DIMENSIONS, VALUE_DIMENSION_KEYS } from "../../src/domain/value";
import type { BusinessObject } from "../../src/domain/objects";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { scoreExternalAsset, assessAssetValue } from "../../src/server/services/asset-service";
import type { AiChatFn } from "../../src/server/services/asset-ai";
import { actor } from "../helpers/actor";

/**
 * 6 维打分 → 三档处置（规格 v2.0 第 4.2、5 节）。
 *
 * 模型只给分数；加权、阈值、等级全部由领域层算。这里用注入的假模型
 * 把三档边界与失败路径逐条钉死，不依赖任何真实服务。
 */

interface ChatPlan {
  /** 6 维统一分，或按维度覆盖。 */
  score?: number | Partial<Record<string, number>>;
  /** 模型返回的维度键缺失（模拟脏输出）。 */
  dropDimension?: string;
  /** 5 维评估统一分。 */
  value?: number;
  scoreError?: boolean;
  valueError?: boolean;
}

function plannedChat(plan: ChatPlan): AiChatFn {
  return async (request) => {
    if (request.system.includes("5 维价值评估")) {
      if (plan.valueError) throw new Error("模型连接失败");
      const value = plan.value ?? 3;
      return JSON.stringify({
        dimensions: VALUE_DIMENSION_KEYS.map((key) => ({ key, score: value, reason: "理由" })),
      });
    }

    if (plan.scoreError) throw new Error("模型连接失败");

    const base = typeof plan.score === "number" ? plan.score : 50;
    const overrides = typeof plan.score === "object" ? plan.score : {};

    return JSON.stringify({
      dimensions: AI_DIMENSIONS.map((dimension) => ({
        key: dimension.key,
        score: overrides[dimension.key] ?? base,
        reason: "理由",
      })).filter((item) => item.key !== plan.dropDimension),
    });
  };
}

function deps(plan: ChatPlan) {
  return { chat: plannedChat(plan), model: "test-model" };
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

function externalAsset(title = "待评审资产"): Promise<BusinessObject> {
  return repo.create({
    type: "asset",
    title,
    library: "external",
    ownerSub: "u1",
    source: "ai_extracted",
    sourceType: "ai_extract",
  });
}

describe("scoreExternalAsset", () => {
  it("总分由领域层加权计算：只有洞察满分 → 25 分判为低价值", async () => {
    const asset = await externalAsset();

    const scored = await scoreExternalAsset(handle.db, actor("u1"), asset.id, deps({
      score: Object.fromEntries(AI_DIMENSIONS.map((d) => [d.key, d.key === "insight" ? 100 : 0])),
    }));

    expect(scored.aiScore).toBe(25);
    expect(scored.aiStatus).toBe("low_value");
    expect(scored.aiScoreDetail?.total).toBe(25);
    expect(scored.aiScoreDetail?.model).toBe("test-model");
    // 未过线：留在外库，也没有等级。
    expect(scored.library).toBe("external");
    expect(scored.valueLevel).toBeNull();
  });

  it("≥75：自动进内库并同时完成 5 维评估", async () => {
    const asset = await externalAsset();

    const scored = await scoreExternalAsset(handle.db, actor("u1"), asset.id, deps({
      score: 80,
      value: 4,
    }));

    expect(scored.aiScore).toBe(80);
    expect(scored.aiStatus).toBe("auto_pass");
    expect(scored.library).toBe("internal");
    expect(scored.valueLevel).toBe("A");
    expect(scored.valueScores?.source).toBe("model");
    expect(scored.valueScores?.dimensions).toHaveLength(5);
    expect(scored.valueAssessedAt).not.toBeNull();

    const events = await repo.listLibraryEvents(asset.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromLibrary: "external",
      toLibrary: "internal",
      actorSub: "u1",
    });
  });

  it("74 分：待人工复核，不动库别", async () => {
    const asset = await externalAsset("74 分");

    const scored = await scoreExternalAsset(handle.db, actor("u1"), asset.id, deps({ score: 74 }));

    expect(scored.aiScore).toBe(74);
    expect(scored.aiStatus).toBe("needs_review");
    expect(scored.library).toBe("external");
    expect(await repo.listLibraryEvents(asset.id)).toHaveLength(0);
  });

  it("60 分：仍是待人工复核（边界含端点）", async () => {
    const asset = await externalAsset("60 分");

    const scored = await scoreExternalAsset(handle.db, actor("u1"), asset.id, deps({ score: 60 }));

    expect(scored.aiStatus).toBe("needs_review");
    expect(scored.library).toBe("external");
  });

  it("59 分：低价值，留在外库", async () => {
    const asset = await externalAsset("59 分");

    const scored = await scoreExternalAsset(handle.db, actor("u1"), asset.id, deps({ score: 59 }));

    expect(scored.aiScore).toBe(59);
    expect(scored.aiStatus).toBe("low_value");
    expect(scored.library).toBe("external");
    expect(scored.valueLevel).toBeNull();
  });

  it("自动入库时价值评估失败：退回确定性兜底，仍然入库（C 级）", async () => {
    const asset = await externalAsset("模型抖动");

    const scored = await scoreExternalAsset(handle.db, actor("u1"), asset.id, deps({
      score: 90,
      valueError: true,
    }));

    expect(scored.library).toBe("internal");
    expect(scored.aiStatus).toBe("auto_pass");
    expect(scored.valueLevel).toBe("C");
    expect(scored.valueScores?.source).toBe("fallback");
  });

  it("打分模型失败：整体失败，资产保持未评分的外库状态", async () => {
    const asset = await externalAsset();

    await expect(
      scoreExternalAsset(handle.db, actor("u1"), asset.id, deps({ scoreError: true })),
    ).rejects.toThrow(/模型连接失败/);

    const after = await repo.findById(asset.id);
    expect(after).toMatchObject({
      aiStatus: "unscored",
      aiScore: null,
      library: "external",
      revision: 1,
    });
  });

  it("模型缺维度时拒绝落库（不允许用缺维的分数算总分）", async () => {
    const asset = await externalAsset();

    await expect(
      scoreExternalAsset(handle.db, actor("u1"), asset.id, deps({ score: 90, dropDimension: "insight" })),
    ).rejects.toMatchObject({ code: "INTERNAL" });

    expect((await repo.findById(asset.id))?.aiStatus).toBe("unscored");
  });

  it("未绑定大模型时给出可行动的中文提示，不发请求", async () => {
    const asset = await externalAsset();

    await expect(
      scoreExternalAsset(handle.db, actor("u1"), asset.id),
    ).rejects.toThrow(/尚未绑定大模型/);
  });

  it("只有外库资产需要打分：内库资产与作品都拒绝", async () => {
    const internal = await repo.create({
      type: "asset",
      title: "内库资产",
      library: "internal",
      ownerSub: "u1",
    });

    await expect(
      scoreExternalAsset(handle.db, actor("u1"), internal.id, deps({ score: 90 })),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const work = await repo.create({
      type: "work",
      title: "作品",
      library: "external",
      category: "article",
      ownerSub: "u1",
    });

    await expect(
      scoreExternalAsset(handle.db, actor("u1"), work.id, deps({ score: 90 })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("他人的资产按不存在处理", async () => {
    const asset = await externalAsset();

    await expect(
      scoreExternalAsset(handle.db, actor("u2"), asset.id, deps({ score: 90 })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("assessAssetValue", () => {
  it("内库资产重评只更新 value_* 三列，并推进 revision", async () => {
    const asset = await repo.create({
      type: "asset",
      title: "内库资产",
      library: "internal",
      ownerSub: "u1",
      valueLevel: "C",
    });

    const assessed = await assessAssetValue(handle.db, actor("u1"), asset.id, deps({
      score: 50,
      value: 5,
    }));

    expect(assessed.valueLevel).toBe("S");
    expect(assessed.valueScores?.source).toBe("model");
    expect(assessed.valueAssessedAt).not.toBeNull();
    // 重评不动 AI 分数与库别
    expect(assessed.aiStatus).toBe("unscored");
    expect(assessed.revision).toBe(asset.revision + 1);
  });

  it("模型失败直接报错，不静默降级（原等级保持不变）", async () => {
    const asset = await repo.create({
      type: "asset",
      title: "好资产",
      library: "internal",
      ownerSub: "u1",
      valueLevel: "S",
    });

    await expect(
      assessAssetValue(handle.db, actor("u1"), asset.id, deps({ score: 50, valueError: true })),
    ).rejects.toThrow(/模型连接失败/);

    expect((await repo.findById(asset.id))?.valueLevel).toBe("S");
  });

  it("外库资产与作品不做价值重评", async () => {
    const external = await externalAsset("外库的");

    await expect(
      assessAssetValue(handle.db, actor("u1"), external.id, deps({ score: 50 })),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const work = await repo.create({
      type: "work",
      title: "作品",
      library: "external",
      category: "article",
      ownerSub: "u1",
    });

    await expect(
      assessAssetValue(handle.db, actor("u1"), work.id, deps({ score: 50 })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
