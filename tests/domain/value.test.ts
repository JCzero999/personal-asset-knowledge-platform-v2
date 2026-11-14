import { describe, expect, it } from "vitest";

import {
  AI_AUTO_PASS_SCORE,
  AI_DIMENSION_KEYS,
  AI_DIMENSION_MAX,
  AI_DIMENSION_MIN,
  AI_DIMENSIONS,
  AI_REVIEW_SCORE,
  AI_SCORE_WEIGHT_TOTAL,
  VALUE_DIMENSION_KEYS,
  VALUE_LEVEL_THRESHOLDS,
  VALUE_SCORE_MAX,
  VALUE_SCORE_MIN,
  aiVerdictFor,
  aiWeightedTotal,
  buildAiScoreDetail,
  buildValueScores,
  fallbackValueScores,
  planDynamicAdjustment,
  reuseScoreFor,
  valueLevelFor,
  type AiDimensionKey,
  type ValueDimensionKey,
} from "../../src/domain/value";

/** 规格 v2.0 第 5、6 节的权重与阈值：这些数字一变，历史分数就不可比。 */

function flatAi(score: number): Record<AiDimensionKey, number> {
  return Object.fromEntries(AI_DIMENSION_KEYS.map((key) => [key, score])) as Record<
    AiDimensionKey,
    number
  >;
}

function flatValue(score: number): Record<ValueDimensionKey, number> {
  return Object.fromEntries(VALUE_DIMENSION_KEYS.map((key) => [key, score])) as Record<
    ValueDimensionKey,
    number
  >;
}

describe("六维打分的权重与阈值", () => {
  it("六个维度齐全，权重合计 100", () => {
    expect(AI_DIMENSIONS.map((item) => item.key)).toEqual([...AI_DIMENSION_KEYS]);
    expect(AI_DIMENSIONS.reduce((sum, item) => sum + item.weight, 0)).toBe(AI_SCORE_WEIGHT_TOTAL);
    expect(AI_SCORE_WEIGHT_TOTAL).toBe(100);
  });

  it("单维分值域 0–100，阈值是 75 / 60", () => {
    expect(AI_DIMENSION_MIN).toBe(0);
    expect(AI_DIMENSION_MAX).toBe(100);
    expect(AI_AUTO_PASS_SCORE).toBe(75);
    expect(AI_REVIEW_SCORE).toBe(60);
  });

  it("加权总分按权重计算，而不是简单平均", () => {
    // insight 权重 25：只有洞察满分、其余零分时总分 25。
    const onlyInsight = aiWeightedTotal({ ...flatAi(0), insight: 100 });
    expect(onlyInsight).toBe(25);

    // completeness 权重 20：只有它满分时总分 20。
    expect(aiWeightedTotal({ ...flatAi(0), completeness: 100 })).toBe(20);

    expect(aiWeightedTotal(flatAi(100))).toBe(100);
  });

  it("先加权再取整：74.5 进位到 75，落入自动通过档", () => {
    const total = aiWeightedTotal({ ...flatAi(74), insight: 76 });
    expect(total).toBe(75);
    expect(aiVerdictFor(total)).toBe("auto_pass");
  });
});

describe("三档判定边界", () => {
  it("≥75 自动通过", () => {
    expect(aiVerdictFor(100)).toBe("auto_pass");
    expect(aiVerdictFor(75)).toBe("auto_pass");
    expect(aiWeightedTotal(flatAi(75))).toBe(75);
  });

  it("60–74 待人工复核（含两端）", () => {
    expect(aiVerdictFor(74)).toBe("needs_review");
    expect(aiVerdictFor(60)).toBe("needs_review");
    expect(aiVerdictFor(60.5)).toBe("needs_review");
    expect(aiWeightedTotal(flatAi(74))).toBe(74);
    expect(aiWeightedTotal(flatAi(60))).toBe(60);
  });

  it("<60 低价值", () => {
    expect(aiVerdictFor(59)).toBe("low_value");
    expect(aiVerdictFor(0)).toBe("low_value");
    expect(aiWeightedTotal(flatAi(59))).toBe(59);
  });
});

describe("buildAiScoreDetail", () => {
  it("逐维带权重与加权贡献，总分与结论由领域层计算", () => {
    const detail = buildAiScoreDetail({
      scores: flatAi(80),
      reasons: { insight: "有反直觉结论" },
      model: "test-model",
      scoredAt: "2026-11-14T00:00:00.000Z",
    });

    expect(detail.total).toBe(80);
    expect(detail.verdict).toBe("auto_pass");
    expect(detail.model).toBe("test-model");
    expect(detail.source).toBe("model");
    expect(detail.dimensions).toHaveLength(6);
    expect(detail.dimensions.find((item) => item.key === "insight")?.weighted).toBe(20);
    expect(detail.dimensions.find((item) => item.key === "insight")?.reason).toBe(
      "有反直觉结论",
    );
    expect(detail.dimensions.find((item) => item.key === "completeness")?.reason).toBe("");
  });
});

describe("五维价值评估的等级边界", () => {
  it("阈值是 S≥21、A≥16、B≥11、其余 C", () => {
    expect(VALUE_LEVEL_THRESHOLDS).toEqual({ S: 21, A: 16, B: 11 });
    expect(VALUE_SCORE_MIN).toBe(1);
    expect(VALUE_SCORE_MAX).toBe(5);
  });

  it("S：21 分成立，20 分降为 A", () => {
    expect(valueLevelFor({ practice: 5, reuse: 4, transferability: 4, uniqueness: 4, timeliness: 4 })).toBe("S");
    expect(valueLevelFor(flatValue(4))).toBe("A");
    expect(valueLevelFor(flatValue(5))).toBe("S");
  });

  it("A：16 分成立，15 分降为 B", () => {
    expect(
      valueLevelFor({ practice: 4, reuse: 3, transferability: 3, uniqueness: 3, timeliness: 3 }),
    ).toBe("A");
    expect(valueLevelFor(flatValue(3))).toBe("B");
  });

  it("B：11 分成立，10 分降为 C", () => {
    expect(
      valueLevelFor({ practice: 3, reuse: 2, transferability: 2, uniqueness: 2, timeliness: 2 }),
    ).toBe("B");
    expect(valueLevelFor(flatValue(2))).toBe("C");
  });

  it("1 分全维是 C 的下界", () => {
    expect(valueLevelFor(flatValue(1))).toBe("C");
  });
});

describe("buildValueScores / fallbackValueScores", () => {
  it("平均分保留两位小数，等级按总分换算", () => {
    const scores = buildValueScores({
      scores: { practice: 5, reuse: 4, transferability: 4, uniqueness: 4, timeliness: 4 },
      reasons: { practice: "有真实数据" },
      model: "test-model",
      assessedAt: "2026-11-14T00:00:00.000Z",
    });

    expect(scores.average).toBe(4.2);
    expect(scores.level).toBe("S");
    expect(scores.source).toBe("model");
    expect(scores.dimensions).toHaveLength(5);
    expect(scores.dimensions.find((item) => item.key === "practice")?.reason).toBe("有真实数据");
  });

  it("确定性兜底：全维 2 分 → C 级，来源标记 fallback", () => {
    const scores = fallbackValueScores("2026-11-14T00:00:00.000Z");

    expect(scores.level).toBe("C");
    expect(scores.average).toBe(2);
    expect(scores.source).toBe("fallback");
    expect(scores.model).toBeNull();
    expect(scores.dimensions.every((item) => item.score === 2)).toBe(true);
    expect(scores.assessedAt).toBe("2026-11-14T00:00:00.000Z");
  });
});

describe("reuseScoreFor", () => {
  it("按近 30 天调用次数落到 1–5 分", () => {
    expect(reuseScoreFor(0)).toBe(1);
    expect(reuseScoreFor(1)).toBe(2);
    expect(reuseScoreFor(2)).toBe(2);
    expect(reuseScoreFor(3)).toBe(3);
    expect(reuseScoreFor(4)).toBe(3);
    expect(reuseScoreFor(5)).toBe(4);
    expect(reuseScoreFor(9)).toBe(4);
    expect(reuseScoreFor(10)).toBe(5);
    expect(reuseScoreFor(30)).toBe(5);
  });
});

describe("planDynamicAdjustment", () => {
  const NOW = "2026-11-14T00:00:00.000Z";

  function plan(overrides: Partial<Parameters<typeof planDynamicAdjustment>[0]> = {}) {
    return planDynamicAdjustment({
      currentLevel: "B",
      scores: flatValue(3),
      useCount30d: 0,
      daysSinceLastUse: 10,
      locked: false,
      lastAdjustedAt: null,
      now: NOW,
      ...overrides,
    });
  }

  it("锁定或 24 小时内调过：一律不动", () => {
    expect(plan({ locked: true, useCount30d: 10, daysSinceLastUse: 1 })).toBeNull();
    expect(
      plan({ useCount30d: 10, daysSinceLastUse: 1, lastAdjustedAt: "2026-11-13T01:00:00.000Z" }),
    ).toBeNull();
  });

  it("刚好 24 小时可以再调", () => {
    const right = plan({
      useCount30d: 5,
      daysSinceLastUse: 1,
      lastAdjustedAt: "2026-11-13T00:00:00.000Z",
    });

    expect(right?.type).toBe("upgrade");
  });

  it("近 30 天 ≥5 次且 30 天内有调用：升一级", () => {
    const result = plan({ useCount30d: 5, daysSinceLastUse: 1 });

    expect(result?.type).toBe("upgrade");
    expect(result?.level).toBe("A");
    expect(result?.scores.level).toBe("A");
    expect(result?.scores.source).toBe("rule");
    expect(result?.scores.dimensions.find((item) => item.key === "reuse")?.score).toBe(4);
    expect(result?.scores.assessedAt).toBe(NOW);
  });

  it("调用不足 5 次或已超 30 天不使用：不升级", () => {
    expect(plan({ useCount30d: 4, daysSinceLastUse: 1 })).toBeNull();
    expect(plan({ useCount30d: 10, daysSinceLastUse: 31 })).toBeNull();
  });

  it("S 级封顶，不会升到不存在的等级", () => {
    const result = plan({
      currentLevel: "S",
      scores: flatValue(4),
      useCount30d: 10,
      daysSinceLastUse: 1,
    });

    expect(result).toBeNull();
  });

  it("升级最多一级：复用从 1 拉到 5 也不会跳档", () => {
    const result = plan({
      currentLevel: "B",
      scores: { ...flatValue(3), reuse: 1 },
      useCount30d: 10,
      daysSinceLastUse: 1,
    });

    expect(result?.level).toBe("A");
  });

  it("超过 90 天未用：降一级；正好 90 天不降", () => {
    expect(plan({ useCount30d: 2, daysSinceLastUse: 90 })).toBeNull();

    const result = plan({ useCount30d: 2, daysSinceLastUse: 91 });
    expect(result?.type).toBe("downgrade");
    expect(result?.level).toBe("C");
  });

  it("零调用且超过 60 天未用：降级；正好 60 天不降", () => {
    expect(plan({ useCount30d: 0, daysSinceLastUse: 60 })).toBeNull();
    expect(plan({ useCount30d: 0, daysSinceLastUse: 61 })?.type).toBe("downgrade");
  });

  it("降级保证真的掉一级：S 仅压复用仍不够时继续下调其他维度", () => {
    const result = plan({
      currentLevel: "S",
      scores: flatValue(5),
      useCount30d: 0,
      daysSinceLastUse: 120,
    });

    expect(result?.type).toBe("downgrade");
    expect(result?.level).toBe("A");
    expect(result?.scores.level).toBe("A");
    // 总分刚好落在 A 档下沿（20），不会一次掉两级。
    expect(result?.scores.dimensions.reduce((sum, item) => sum + item.score, 0)).toBe(20);
  });

  it("C 级不再降", () => {
    expect(
      plan({ currentLevel: "C", scores: flatValue(2), useCount30d: 0, daysSinceLastUse: 200 }),
    ).toBeNull();
  });
});
