import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AI_DIMENSIONS, VALUE_DIMENSION_KEYS } from "../../src/domain/value";
import type { BusinessObject } from "../../src/domain/objects";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { extractAssetsFromWork } from "../../src/server/services/asset-service";
import type { AiChatFn } from "../../src/server/services/asset-ai";
import { actor } from "../helpers/actor";
import { seedTag } from "../helpers/seed";

/**
 * AI 提炼（规格 v2.0 第 3.1 节）：只有外库作品的「草稿」可以触发。
 * 提炼产物一律进外库（source=ai_extracted / source_type=ai_extract），
 * 然后逐条打分；打分失败的那条保持 unscored，不丢提炼成果。
 */

interface ChatPlan {
  extract?: string;
  extractError?: boolean;
  score?: number;
  scoreError?: boolean;
}

const CONTENT = [
  "选题四象限法把选题按「需求强度」和「差异度」两个维度切分，形成四个象限。第一象限是需求强、差异度高，适合优先投入；第二象限是需求强、差异度低，需要靠执行和渠道取胜；第三象限是需求弱、差异度高，适合小成本试验；第四象限是需求弱、差异度低，应当直接放弃。",
  "交付检查清单用于开课前逐项确认：先确认课程目标与受众，再检查素材、演练与备份方案，最后确认通知、场地和设备。清单的价值不在于长，而在于每一项都能在出问题前被检查到，并且每次复盘后只增补真正踩过的坑，把经验变成下一次的默认动作。",
].join("\n\n");

/** 摘要 60–120 字、摘录 100–300 字且逐字摘自 CONTENT（v2.1 §1）。 */
const EXTRACT_BODY = JSON.stringify({
  assets: [
    {
      title: "选题四象限法",
      summary:
        "选题四象限用需求强度和差异度两个维度把题目分成四类，只有需求强且差异度高的象限值得优先投入，其余象限要么靠执行取胜，要么小成本试验，要么直接放弃。",
      scenario: "判断一个选题是否值得投入",
      keyPoints: ["需求强、差异度高：优先投入资源", "需求弱、差异度低：直接放弃"],
      excerpt:
        "选题四象限法把选题按「需求强度」和「差异度」两个维度切分，形成四个象限。第一象限是需求强、差异度高，适合优先投入；第二象限是需求强、差异度低，需要靠执行和渠道取胜；第三象限是需求弱、差异度高，适合小成本试验；第四象限是需求弱、差异度低，应当直接放弃。",
      tags: ["复盘", "未登记标签"],
    },
    {
      title: "交付检查清单",
      summary:
        "交付检查清单把课程开始前必须确认的事项固定下来，依次检查目标与受众、素材与演练、通知与设备，价值在于每项都能在出问题前被发现，并在每次复盘后只增补真正踩过的坑。",
      scenario: "开课前做最后确认",
      keyPoints: ["按目标、素材、通知、设备的顺序逐项确认", "每次复盘后只增补真正踩过的坑"],
      excerpt:
        "交付检查清单用于开课前逐项确认：先确认课程目标与受众，再检查素材、演练与备份方案，最后确认通知、场地和设备。清单的价值不在于长，而在于每一项都能在出问题前被检查到，并且每次复盘后只增补真正踩过的坑，把经验变成下一次的默认动作。",
      tags: [],
    },
  ],
});

function plannedChat(plan: ChatPlan): AiChatFn {
  return async (request) => {
    if (request.system.includes("内容提炼助手")) {
      if (plan.extractError) throw new Error("模型连接失败");
      return plan.extract ?? EXTRACT_BODY;
    }

    if (request.system.includes("5 维价值评估")) {
      return JSON.stringify({
        dimensions: VALUE_DIMENSION_KEYS.map((key) => ({ key, score: 4, reason: "理由" })),
      });
    }

    if (plan.scoreError) throw new Error("打分模型连接失败");

    const score = plan.score ?? 80;

    return JSON.stringify({
      dimensions: AI_DIMENSIONS.map((dimension) => ({
        key: dimension.key,
        score,
        reason: "理由",
      })),
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

function draftWork(title = "复盘方法论"): Promise<BusinessObject> {
  return repo.create({
    type: "work",
    title,
    description: "一次课程复盘的全部记录",
    library: "external",
    category: "article",
    priority: "high",
    ownerSub: "u1",
  });
}

function deps(plan: ChatPlan = {}, content = CONTENT) {
  return {
    chat: plannedChat(plan),
    model: "test-model",
    readContent: async () => content,
  };
}

describe("extractAssetsFromWork", () => {
  it("从草稿提炼外库资产，逐条打分并自动入库", async () => {
    const work = await draftWork();

    const assets = await extractAssetsFromWork(handle.db, actor("u1"), work.id, deps());

    expect(assets).toHaveLength(2);
    expect(assets.map((asset) => asset.title)).toEqual(["选题四象限法", "交付检查清单"]);

    for (const asset of assets) {
      expect(asset).toMatchObject({
        type: "asset",
        source: "ai_extracted",
        sourceType: "ai_extract",
        aiStatus: "auto_pass",
        // 80 分 → 自动通过，落到内库并带 A 级评估。
        library: "internal",
        valueLevel: "A",
        category: work.category,
        priority: "high",
      });
      expect(asset.aiScore).toBe(80);
      // 提炼产物都指回触发它的草稿（幂等查重看这一列）。
      expect(asset.originWorkId).toBe(work.id);
    }

    // 只挂词表里已有的标签，未知标签被丢弃（ADR-023 不允许隐式建词条）。
    expect(assets[0].tags).toEqual(["复盘"]);
    expect(assets[1].tags).toEqual([]);

    // 原文摘录写入正文快照，hash 取整篇正文（v2.1 §1/§4）。
    const hash = createHash("sha256").update(CONTENT, "utf8").digest("hex");
    for (const asset of assets) {
      expect(asset.contentHash).toBe(hash);
      expect(asset.contentSnapshotAt).not.toBeNull();
      expect(Array.from(asset.contentSnapshot ?? "").length).toBeGreaterThanOrEqual(100);
      expect(Array.from(asset.contentSnapshot ?? "").length).toBeLessThanOrEqual(300);
      expect(CONTENT).toContain(asset.contentSnapshot!);
    }

    // 提炼不改动作品本身：仍是 draft，也不写实践字段。
    const after = await repo.findById(work.id);
    expect(after).toMatchObject({ status: "draft", settledAssetId: null });
  });

  it("把作品标题和正文送进模型提示词", async () => {
    const work = await draftWork("我的复盘");
    const prompts: string[] = [];

    const chat: AiChatFn = async (request) => {
      prompts.push(request.user);
      return EXTRACT_BODY;
    };

    await extractAssetsFromWork(handle.db, actor("u1"), work.id, {
      chat,
      readContent: async () => CONTENT,
    });

    expect(prompts[0]).toContain("我的复盘");
    expect(prompts[0]).toContain(CONTENT);
  });

  it("非草稿作品不能提炼（409）", async () => {
    const work = await draftWork();
    await repo.changeStatus({ objectId: work.id, to: "finished" });

    await expect(
      extractAssetsFromWork(handle.db, actor("u1"), work.id, deps()),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await repo.list({ type: "asset" })).toHaveLength(0);
  });

  it("作品没有正文返回 NO_CONTENT（422）", async () => {
    const work = await draftWork();

    await expect(
      extractAssetsFromWork(handle.db, actor("u1"), work.id, deps({}, "   ")),
    ).rejects.toMatchObject({ code: "NO_CONTENT" });

    expect(await repo.list({ type: "asset" })).toHaveLength(0);
  });

  it("资产与非本人对象不能触发提炼", async () => {
    const work = await draftWork();
    const asset = await repo.create({
      type: "asset",
      title: "资产",
      library: "external",
      ownerSub: "u1",
    });

    await expect(
      extractAssetsFromWork(handle.db, actor("u1"), asset.id, deps()),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      extractAssetsFromWork(handle.db, actor("u2"), work.id, deps()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("模型输出不是 JSON：整体失败，不落任何资产", async () => {
    const work = await draftWork();

    await expect(
      extractAssetsFromWork(
        handle.db,
        actor("u1"),
        work.id,
        deps({ extract: "这不是 JSON" }),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL" });

    expect(await repo.list({ type: "asset" })).toHaveLength(0);
  });

  it("模型返回空数组：不创建资产，作品保持草稿", async () => {
    const work = await draftWork();

    const assets = await extractAssetsFromWork(
      handle.db,
      actor("u1"),
      work.id,
      deps({ extract: JSON.stringify({ assets: [] }) }),
    );

    expect(assets).toEqual([]);
    expect((await repo.findById(work.id))?.status).toBe("draft");
  });

  it("重复提炼被拒绝：第二次 409，资产数不变", async () => {
    const work = await draftWork();

    const first = await extractAssetsFromWork(handle.db, actor("u1"), work.id, deps());
    expect(first).toHaveLength(2);

    await expect(
      extractAssetsFromWork(handle.db, actor("u1"), work.id, deps()),
    ).rejects.toMatchObject({ code: "EXTRACT_DUPLICATE" });

    expect(await repo.list({ type: "asset" })).toHaveLength(2);
  });

  it("删除旧资产后允许重新提炼", async () => {
    const work = await draftWork();
    const first = await extractAssetsFromWork(handle.db, actor("u1"), work.id, deps());

    for (const asset of first) {
      await repo.softDelete(asset.id);
    }

    const again = await extractAssetsFromWork(handle.db, actor("u1"), work.id, deps());
    expect(again).toHaveLength(2);
    expect(await repo.list({ type: "asset" })).toHaveLength(2);
  });

  it("单条打分失败：提炼产物保留为 unscored，不阻塞其余资产", async () => {
    const work = await draftWork();

    const assets = await extractAssetsFromWork(
      handle.db,
      actor("u1"),
      work.id,
      deps({ scoreError: true }),
    );

    expect(assets).toHaveLength(2);
    for (const asset of assets) {
      expect(asset).toMatchObject({
        library: "external",
        aiStatus: "unscored",
        aiScore: null,
        valueLevel: null,
      });
    }
  });
});
