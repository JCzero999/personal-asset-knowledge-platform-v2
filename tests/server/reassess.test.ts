import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ValidationError } from "../../src/domain/errors";
import { VALUE_DIMENSION_KEYS, buildValueScores } from "../../src/domain/value";
import type { BusinessObject } from "../../src/domain/objects";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import type { AiChatFn } from "../../src/server/services/asset-ai";
import { parseReassessBody, reassessAssets } from "../../src/server/services/reassess-service";
import { actor } from "../helpers/actor";

/**
 * 批量重评（v2.1 §5）：按 id 或筛选条件逐条重跑模型；
 * 单条失败继续其余条，失败写审计供后台指标统计。
 */

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

const T1 = "2026-11-01T00:00:00.000Z";

function chat(options: { failOn?: string; value?: number } = {}): AiChatFn {
  return async (request) => {
    if (!request.system.includes("5 维价值评估")) {
      throw new Error("不该调用这里的提示词");
    }

    if (options.failOn && request.user.includes(options.failOn)) {
      throw new Error("模型调用失败");
    }

    const value = options.value ?? 4;

    return JSON.stringify({
      dimensions: VALUE_DIMENSION_KEYS.map((key) => ({ key, score: value, reason: "理由" })),
    });
  };
}

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec(`
    DELETE FROM value_assessment_history;
    DELETE FROM audit_events;
    DELETE FROM objects;
  `);
  repo = new SqliteObjectRepository(handle.db);
});

function asset(
  title: string,
  options: { ownerSub?: string; level?: "S" | "A" | "B" | "C"; source?: "model" | "fallback" } = {},
): Promise<BusinessObject> {
  return repo.create({
    type: "asset",
    title,
    library: "internal",
    source: "handwritten",
    ownerSub: options.ownerSub ?? "u1",
    valueLevel: options.level ?? "C",
    valueScores: buildValueScores({
      scores: {
        practice: 3,
        reuse: 3,
        transferability: 3,
        uniqueness: 3,
        timeliness: 3,
      },
      assessedAt: T1,
      source: options.source ?? "model",
    }),
    valueAssessedAt: T1,
    now: T1,
  });
}

describe("parseReassessBody", () => {
  it("接受 ids 与 filter，拒绝非法值", () => {
    expect(() => parseReassessBody({ ids: ["a", "b", "a"] })).toThrow(ValidationError);
    expect(parseReassessBody({ ids: ["a", "b"] })).toEqual({ ids: ["a", "b"], filter: {} });
    expect(parseReassessBody({ filter: { level: "A", source: "fallback" } })).toEqual({
      filter: { level: "A", source: "fallback" },
    });
    expect(parseReassessBody({})).toEqual({ filter: {} });

    expect(() => parseReassessBody({ filter: { level: "Z" } })).toThrow(ValidationError);
    expect(() => parseReassessBody({ filter: { source: "magic" } })).toThrow(ValidationError);
    expect(() => parseReassessBody({ ids: "a" })).toThrow(ValidationError);
    expect(() => parseReassessBody({ ids: Array.from({ length: 51 }, (_, i) => `id-${i}`) })).toThrow(
      ValidationError,
    );
  });
});

describe("reassessAssets", () => {
  it("按 id 重评：成功条目更新等级，失败条目继续其余条并写审计", async () => {
    const good = await asset("好资产");
    const bad = await asset("坏资产");

    const result = await reassessAssets(
      handle.db,
      actor("u1"),
      { ids: [good.id, bad.id] },
      { chat: chat({ failOn: "坏资产" }) },
    );

    expect(result.ok).toEqual([{ id: good.id, title: "好资产", valueLevel: "A" }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(bad.id);

    expect((await repo.findById(good.id))?.valueLevel).toBe("A");
    expect((await repo.findById(bad.id))?.valueLevel).toBe("C");

    const audit = handle.sqlite
      .prepare("select action, result, target_id from audit_events where action = 'value.reassess_failed'")
      .all() as { action: string; result: string; target_id: string }[];
    expect(audit).toEqual([
      { action: "value.reassess_failed", result: "error", target_id: bad.id },
    ]);
  });

  it("按等级与来源筛选，只处理本人内库资产", async () => {
    await asset("A 级模型资产", { level: "A", source: "model" });
    await asset("A 级兜底资产", { level: "A", source: "fallback" });
    await asset("B 级资产", { level: "B" });
    await asset("别人的资产", { ownerSub: "u2", level: "A" });

    const onlyFallback = await reassessAssets(
      handle.db,
      actor("u1"),
      { filter: { level: "A", source: "fallback" } },
      { chat: chat({ value: 5 }) },
    );

    expect(onlyFallback.ok.map((item) => item.title)).toEqual(["A 级兜底资产"]);
    expect((await repo.findById(onlyFallback.ok[0].id))?.valueLevel).toBe("S");
  });

  it("传别人的 id 按失败处理，不泄露对象存在性", async () => {
    const other = await asset("别人的资产", { ownerSub: "u2" });

    const result = await reassessAssets(
      handle.db,
      actor("u1"),
      { ids: [other.id] },
      { chat: chat() },
    );

    expect(result.ok).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toContain("不存在");
  });

  it("作品 id 也会记为失败而不是中断整批", async () => {
    const work = await repo.create({
      type: "work",
      title: "课程复盘",
      library: "external",
      category: "article",
      ownerSub: "u1",
    });
    const good = await asset("好资产");

    const result = await reassessAssets(
      handle.db,
      actor("u1"),
      { ids: [work.id, good.id] },
      { chat: chat() },
    );

    expect(result.ok.map((item) => item.id)).toEqual([good.id]);
    expect(result.failed.map((item) => item.id)).toEqual([work.id]);
  });
});
