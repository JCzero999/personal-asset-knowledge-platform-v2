import { describe, expect, it } from "vitest";

import type { AssetObject, BusinessObject, Library, WorkObject } from "../../src/domain/objects";
import {
  aiBadge,
  dimensionLabel,
  filterByLifecycle,
  formatScore,
  lifecycleBadges,
  parseLifecycleFilters,
  readAiStatus,
  readValueLevel,
  scorePercent,
  valueBadge,
  weightPercent,
  withLifecycleParams,
} from "../../src/components/lifecycle";

/**
 * 生命周期展示规则（规格 v2.0 第 5、6 节）：
 * 外库看 AI 状态、内库看价值等级；字段为空时按「未打分 / 未评估」兜底。
 */

const base = {
  id: "01J00000000000000000000000",
  type: "asset" as const,
  title: "示例资产",
  description: null,
  library: "external" as Library,
  source: "handwritten" as const,
  origin: "self" as const,
  category: null,
  tags: [] as string[],
  priority: "medium" as const,
  archivedAt: null,
  libraryChangedAt: null,
  ownerSub: "user-1",
  revision: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  publishedAt: null,
  practicedAt: null,
  practiceMetrics: null,
  settledAssetId: null,
  sourceType: null,
  aiStatus: null,
  aiScore: null,
  aiScoreDetail: null,
  valueLevel: null,
  valueScores: null,
  valueAssessedAt: null,
  useCount: 0,
  lastUsedAt: null,
  originWorkId: null,
  status: null,
  sourceNote: null,
};

function asset(overrides: Partial<AssetObject> = {}, library: Library = "external"): AssetObject {
  return { ...base, library, ...overrides };
}

function work(overrides: Partial<WorkObject> = {}): BusinessObject {
  return {
    ...base,
    type: "work",
    category: "article",
    status: "published",
    ...overrides,
  } as unknown as WorkObject;
}

describe("aiBadge", () => {
  it("外库资产按 aiStatus 与分数给出中文徽标", () => {
    expect(aiBadge(asset({ aiStatus: "auto_pass", aiScore: 85 }))).toEqual({
      key: "ai-auto_pass",
      label: "85 分 · AI 推荐",
      tone: "ok",
    });
    expect(aiBadge(asset({ aiStatus: "needs_review", aiScore: 68 }))).toEqual({
      key: "ai-needs_review",
      label: "68 分 · 待人工复核",
      tone: "warn",
    });
    expect(aiBadge(asset({ aiStatus: "low_value", aiScore: 42 }))?.tone).toBe("danger");
  });

  it("字段为空时按「未打分」兜底", () => {
    expect(aiBadge(asset())).toEqual({ key: "ai-unscored", label: "未打分", tone: "muted" });
    expect(aiBadge(asset({ aiStatus: null }))?.label).toBe("未打分");
  });

  it("分数只从 aiScoreDetail.total 拿到时也能展示", () => {
    const detail = {
      dimensions: [],
      total: 81,
      verdict: "auto_pass" as const,
      model: "test",
      scoredAt: "2026-11-14T00:00:00.000Z",
      source: "model" as const,
    };

    expect(aiBadge(asset({ aiStatus: "auto_pass", aiScoreDetail: detail }))?.label)
      .toBe("81 分 · AI 推荐");
  });

  it("内库资产与作品不显示 AI 徽标", () => {
    expect(aiBadge(asset({ aiStatus: "auto_pass" }, "internal"))).toBeNull();
    expect(aiBadge(work())).toBeNull();
  });
});

describe("valueBadge", () => {
  it("内库资产的 S/A 分别落在 success / info 语义色", () => {
    expect(valueBadge(asset({ valueLevel: "S" }, "internal"))).toEqual({
      key: "level-S",
      label: "S 级",
      tone: "ok",
    });
    expect(valueBadge(asset({ valueLevel: "A" }, "internal"))?.tone).toBe("info");
    expect(valueBadge(asset({ valueLevel: "B" }, "internal"))?.tone).toBe("muted");
    expect(valueBadge(asset({ valueLevel: "C" }, "internal"))?.tone).toBe("warn");
  });

  it("没有等级或不在内库时返回 null", () => {
    expect(valueBadge(asset({}, "internal"))).toBeNull();
    expect(valueBadge(asset({ valueLevel: "S" }))).toBeNull();
  });
});

describe("lifecycleBadges", () => {
  it("外库看评分、内库看等级，作品不带徽标", () => {
    expect(lifecycleBadges(asset({ aiStatus: "needs_review" })).map((badge) => badge.label))
      .toEqual(["待人工复核"]);
    expect(lifecycleBadges(asset({ valueLevel: "A" }, "internal")).map((badge) => badge.label))
      .toEqual(["A 级"]);
    expect(lifecycleBadges(work())).toEqual([]);
  });
});

describe("readAiStatus / readValueLevel", () => {
  it("非法值当作缺省", () => {
    const record = { ...asset(), aiStatus: "weird", valueLevel: "Z" } as unknown as AssetObject;
    expect(readAiStatus(record)).toBe("unscored");
    expect(readValueLevel(record)).toBeNull();
  });
});

describe("filterByLifecycle", () => {
  it("按复核状态与价值等级筛选，并排除作品", () => {
    const objects: BusinessObject[] = [
      asset({ aiStatus: "needs_review", aiScore: 66 }),
      asset({ aiStatus: "low_value", aiScore: 30 }),
      asset({ aiStatus: "approved", aiScore: 70 }),
      asset({ valueLevel: "S" }, "internal"),
      work(),
    ];

    expect(
      filterByLifecycle(objects, { aiStatus: "needs_review", valueLevel: null }).map((item) => item.id),
    ).toEqual([objects[0].id]);

    expect(
      filterByLifecycle(objects, { aiStatus: null, valueLevel: "S" }).map((item) => item.id),
    ).toEqual([objects[3].id]);

    expect(filterByLifecycle(objects, { aiStatus: null, valueLevel: null })).toHaveLength(5);
  });

  it("不改动原数组", () => {
    const objects = [asset({ aiStatus: "needs_review" })];
    const result = filterByLifecycle(objects, { aiStatus: null, valueLevel: null });
    expect(result).not.toBe(objects);
    expect(result).toEqual(objects);
  });
});

describe("parseLifecycleFilters", () => {
  it("只接受合法取值，非法值退回 null", () => {
    expect(parseLifecycleFilters({ aiStatus: "needs_review", valueLevel: "A" })).toEqual({
      aiStatus: "needs_review",
      valueLevel: "A",
    });
    expect(parseLifecycleFilters({ aiStatus: "auto_pass", valueLevel: "Z" })).toEqual({
      aiStatus: null,
      valueLevel: null,
    });
    expect(parseLifecycleFilters({})).toEqual({ aiStatus: null, valueLevel: null });
  });
});

describe("withLifecycleParams", () => {
  it("保留已有查询参数并追加生命周期条件", () => {
    expect(
      withLifecycleParams("/workspace?q=笔记&type=asset", {
        aiStatus: "needs_review",
        valueLevel: null,
      }),
    ).toBe("/workspace?q=%E7%AC%94%E8%AE%B0&type=asset&aiStatus=needs_review");
  });

  it("条件清空后地址回到原样", () => {
    expect(
      withLifecycleParams("/workspace?aiStatus=needs_review&valueLevel=S", {
        aiStatus: null,
        valueLevel: null,
      }),
    ).toBe("/workspace");
  });
});

describe("分数与权重", () => {
  it("formatScore 整数不带小数", () => {
    expect(formatScore(85)).toBe("85");
    expect(formatScore(68.25)).toBe("68.3");
  });

  it("scorePercent 按满分换算并截断", () => {
    expect(scorePercent(80, 100)).toBe(80);
    expect(scorePercent(5, 5)).toBe(100);
    expect(scorePercent(120, 100)).toBe(100);
    expect(scorePercent(undefined, 10)).toBe(0);
  });

  it("weightPercent 同时接受 0.2 与 20", () => {
    expect(weightPercent(0.2)).toBe(20);
    expect(weightPercent(25)).toBe(25);
    expect(weightPercent(undefined)).toBeNull();
  });

  it("维度缺 label 时按 key 回退到规格里的中文名", () => {
    expect(dimensionLabel({ key: "insight" }, "ai")).toBe("洞察深度 / 非显而易见性");
    expect(dimensionLabel({ key: "reuse" }, "value")).toBe("复用频率 / 复利潜力");
    expect(dimensionLabel({ key: "custom", label: "自定义维度" }, "ai")).toBe("自定义维度");
  });
});
