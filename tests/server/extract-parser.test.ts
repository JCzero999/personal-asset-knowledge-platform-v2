import { describe, expect, it } from "vitest";

import { parseExtractedAssets, type ExtractDiscard } from "../../src/server/services/asset-ai";

/**
 * 提炼结果收敛（规格 v2.1 §1）：不合格条目不产出碎条，超长字段截断，
 * 摘录必须逐字摘自正文。这里只测解析器，不触网、不落库。
 */

const SAMPLE_SUMMARY =
  "复盘按事实记录、单点归因、写成下一次动作三步循环，每一轮只沉淀一条真正改变行为的结论，长期看比一次性写很长的总结更有效，也更容易落地执行。";

const SOURCE = [
  "复盘的第一步是把事实和判断分开记录：事实写清时间、对象与结果，判断单独成段并标注当时的假设。",
  "第二步只挑一个最关键的差距做归因，避免同时改太多变量，否则下次复盘无法判断是哪一项起了作用。",
  "第三步把结论写成下一次可执行的动作，动作要具体到时间点和完成标准，并在下一次复盘时首先核对。",
  "这套三步法可以循环使用，每一轮只沉淀一条真正改变行为的结论，长期看比一次性写很长的总结更有效。",
].join("");

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    assets: [
      {
        title: "复盘三步法",
        summary: SAMPLE_SUMMARY,
        scenario: "项目或课程结束后的复盘",
        keyPoints: ["事实与判断分开记录", "只挑一个关键差距归因"],
        excerpt: SOURCE.slice(0, 120),
        tags: ["复盘"],
        ...overrides,
      },
    ],
  });
}

function collect(): { discards: ExtractDiscard[]; onDiscard: (info: ExtractDiscard) => void } {
  const discards: ExtractDiscard[] = [];

  return { discards, onDiscard: (info) => discards.push(info) };
}

describe("parseExtractedAssets", () => {
  it("合法条目按 summary + scenario + keyPoints 拼出 description", () => {
    const [asset] = parseExtractedAssets(body(), { sourceText: SOURCE });

    expect(asset.title).toBe("复盘三步法");
    expect(asset.description).toBe(
      `${asset.summary}｜适用场景：${asset.scenario}｜要点：${asset.keyPoints.join("；")}`,
    );
    expect(asset.description.length).toBeLessThanOrEqual(500);
    expect(asset.excerpt).toBe(SOURCE.slice(0, 120));
    expect(asset.tags).toEqual(["复盘"]);
  });

  it("碎片条目丢弃：摘要不足、要点不足、摘录不足逐条记原因", () => {
    const { discards, onDiscard } = collect();
    const text = JSON.stringify({
      assets: [
        { title: "碎片一", summary: "一句话。", scenario: "场景", keyPoints: ["a", "b"], excerpt: SOURCE.slice(0, 120) },
        { title: "碎片二", summary: "知".repeat(80), scenario: "场景", keyPoints: ["只有一条"], excerpt: SOURCE.slice(0, 120) },
        { title: "碎片三", summary: "知".repeat(80), scenario: "场景", keyPoints: ["a", "b"], excerpt: "太短了" },
        {
          title: "完整条目",
          summary: SAMPLE_SUMMARY,
          scenario: "复盘",
          keyPoints: ["事实与判断分开", "只挑一个差距归因"],
          excerpt: SOURCE.slice(0, 120),
        },
      ],
    });

    const assets = parseExtractedAssets(text, { sourceText: SOURCE, onDiscard });

    expect(assets.map((asset) => asset.title)).toEqual(["完整条目"]);
    expect(discards.map((info) => info.reason)).toEqual([
      "摘要不足 60 字，疑似碎片",
      "要点不足 2 条",
      "原文摘录不足 100 字",
    ]);
  });

  it("摘录不是正文的逐字片段时丢弃", () => {
    const { discards, onDiscard } = collect();
    const assets = parseExtractedAssets(
      body({ excerpt: "这是一段被模型改写过的总结，虽然意思接近原文，但并不是逐字摘录，因此不能作为正文快照保存下来。".repeat(3) }),
      { sourceText: SOURCE, onDiscard },
    );

    expect(assets).toEqual([]);
    expect(discards[0]?.reason).toBe("原文摘录不是正文的逐字片段");
  });

  it("超长字段截断而不是整条丢弃", () => {
    const [asset] = parseExtractedAssets(
      body({
        title: `1. ${"标题".repeat(20)}`,
        summary: "知".repeat(200),
        scenario: "场".repeat(60),
        keyPoints: Array.from({ length: 5 }, () => "点".repeat(60)),
        excerpt: SOURCE.repeat(2),
        tags: ["复盘", "复盘", "方法", "课程", "多余"],
      }),
      { sourceText: SOURCE.repeat(2) },
    );

    expect(Array.from(asset.title)).toHaveLength(30);
    expect(asset.title.startsWith("标题")).toBe(true);
    expect(Array.from(asset.summary)).toHaveLength(120);
    expect(Array.from(asset.scenario)).toHaveLength(40);
    expect(asset.keyPoints).toHaveLength(4);
    expect(asset.keyPoints.every((point) => Array.from(point).length === 50)).toBe(true);
    expect(Array.from(asset.excerpt)).toHaveLength(300);
    expect(SOURCE.repeat(2).startsWith(asset.excerpt)).toBe(true);
    expect(asset.tags).toEqual(["复盘", "方法", "课程"]);
    expect(asset.description.length).toBeLessThanOrEqual(500);
  });

  it("剥掉模型加的序号", () => {
    for (const title of ["1. 复盘三步法", "1、复盘三步法", "（1）复盘三步法", "第一、复盘三步法"]) {
      const [asset] = parseExtractedAssets(body({ title }), { sourceText: SOURCE });
      expect(asset.title).toBe("复盘三步法");
    }
  });

  it("最多保留 5 条，空标签不丢条目", () => {
    const text = JSON.stringify({
      assets: Array.from({ length: 7 }, (_, index) => ({
        title: `条目${index}`,
        summary: "知".repeat(80),
        scenario: "场景",
        keyPoints: ["a", "b"],
        excerpt: SOURCE.slice(0, 120),
        tags: [],
      })),
    });

    const assets = parseExtractedAssets(text, { sourceText: SOURCE });

    expect(assets).toHaveLength(5);
    expect(assets[0].tags).toEqual([]);
  });
});
