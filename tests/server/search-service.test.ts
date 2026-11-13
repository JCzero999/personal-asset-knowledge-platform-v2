import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actor } from "../helpers/actor";

import { QuerySyntaxError, ValidationError } from "../../src/domain/errors";
import type {
  RagflowChunk,
  RagflowDataset,
  RagflowRetrievalResult,
} from "../../src/server/adapters/ragflow";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteContentStore } from "../../src/server/repositories/sqlite-content-store";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { createObject, setObjectArchived } from "../../src/server/services/object-service";
import {
  parseSearchQuery,
  searchContent,
  type SearchGateway,
} from "../../src/server/services/search-service";
import { createTag } from "../../src/server/services/vocabulary-service";

/**
 * 检索服务测试：RAGFlow 召回用假网关，词法层直接查内存库。
 * 重点验证混合编排、3 秒超时降级，以及归属 / 归档 / 库别过滤不会被任何一层绕过。
 */

const OWNER = "user_1";
const OTHER = "user_2";

let handle: DatabaseHandle;
let store: SqliteContentStore;

class FakeSearchGateway implements SearchGateway {
  datasets: RagflowDataset[] = [];
  chunks: RagflowChunk[] = [];
  retrieveCalls: { question: string; datasetIds: string[]; pageSize?: number }[] = [];
  listCalls = 0;
  failList: Error | null = null;
  /** true 时 retrieve 永不返回，用来测 3 秒硬超时。 */
  hang = false;

  async listDatasets(): Promise<RagflowDataset[]> {
    this.listCalls += 1;
    if (this.failList) throw this.failList;
    return this.datasets;
  }

  async retrieve(input: {
    question: string;
    datasetIds: string[];
    pageSize?: number;
  }): Promise<RagflowRetrievalResult> {
    this.retrieveCalls.push(input);

    if (this.hang) {
      return new Promise<RagflowRetrievalResult>(() => {});
    }

    return {
      chunks: this.chunks.slice(0, input.pageSize ?? 10),
      total: this.chunks.length,
    };
  }
}

function chunk(documentId: string, content = `content of ${documentId}`): RagflowChunk {
  return {
    id: `chunk_${documentId}`,
    content,
    highlight: `<em>${content}</em>`,
    documentId,
    documentName: `${documentId}.txt`,
    datasetId: "ds_main",
    similarity: 0.8,
    termSimilarity: 0.5,
    vectorSimilarity: 0.7,
  };
}

async function seedRef(ownerSub: string, documentId: string, title = `对象 ${documentId}`) {
  const object = await createObject(handle.db, actor(ownerSub), {
    type: "asset",
    title,
    library: "internal",
  });
  await store.upsert({
    ownerType: "asset",
    ownerId: object.id,
    datasetId: "ds_main",
    documentId,
    contentKey: `obj:${object.id}:primary`,
    parseStatus: "succeeded",
  });
  return object;
}

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec(`
    DELETE FROM object_tags;
    DELETE FROM objects;
    DELETE FROM tags;
    DELETE FROM sync_jobs;
    DELETE FROM content_refs;
  `);
  store = new SqliteContentStore(handle.db);
});

describe("parseSearchQuery", () => {
  it("解析搜索词、条数、库别、阈值与模式", () => {
    expect(
      parseSearchQuery(
        new URLSearchParams("q= 分布式事务 &limit=5&library=external&threshold=0.3&mode=lexical"),
      ),
    ).toEqual({
      question: "分布式事务",
      limit: 5,
      library: "external",
      similarityThreshold: 0.3,
      mode: "lexical",
    });
  });

  it("拒绝空搜索词与越界参数", () => {
    expect(() => parseSearchQuery(new URLSearchParams("q=   "))).toThrow(ValidationError);
    expect(() => parseSearchQuery(new URLSearchParams(`q=${"长".repeat(201)}`))).toThrow(
      ValidationError,
    );
    expect(() => parseSearchQuery(new URLSearchParams("q=a&limit=0"))).toThrow(ValidationError);
    expect(() => parseSearchQuery(new URLSearchParams("q=a&limit=51"))).toThrow(ValidationError);
    expect(() => parseSearchQuery(new URLSearchParams("q=a&library=both"))).toThrow(
      ValidationError,
    );
    expect(() => parseSearchQuery(new URLSearchParams("q=a&threshold=1.5"))).toThrow(
      ValidationError,
    );
    expect(() => parseSearchQuery(new URLSearchParams("q=a&mode=fuzzy"))).toThrow(ValidationError);
  });
});

describe("语义检索（既有行为）", () => {
  it("只返回当前用户未归档对象的命中，并带出对象摘要", async () => {
    const mine = await seedRef(OWNER, "doc_mine");
    const archived = await seedRef(OWNER, "doc_archived");
    await setObjectArchived(handle.db, actor(OWNER), archived.id, { archived: true });
    await seedRef(OTHER, "doc_other");

    const gateway = new FakeSearchGateway();
    gateway.chunks = [
      chunk("doc_other"),
      chunk("doc_none"),
      chunk("doc_archived"),
      chunk("doc_mine"),
    ];

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "codename", mode: "semantic" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(result.total).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      documentId: "doc_mine",
      documentName: "doc_mine.txt",
      similarity: 0.8,
      source: "semantic",
      object: { id: mine.id, title: "对象 doc_mine", library: "internal", type: "asset" },
    });
    expect(result.semantic).toMatchObject({ status: "ok", thresholdApplied: true });
  });

  it("按库别过滤，并在过滤前多召回一些", async () => {
    const internal = await seedRef(OWNER, "doc_internal");
    const external = await createObject(handle.db, actor(OWNER), {
      type: "work",
      title: "外库作品",
      library: "external",
      category: "article",
    });
    await store.upsert({
      ownerType: "work",
      ownerId: external.id,
      datasetId: "ds_main",
      documentId: "doc_external",
      contentKey: `obj:${external.id}:primary`,
    });

    const gateway = new FakeSearchGateway();
    gateway.chunks = [chunk("doc_internal"), chunk("doc_external")];

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "课程", library: "external", limit: 5, mode: "semantic" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(gateway.retrieveCalls[0]).toMatchObject({ datasetIds: ["ds_main"], pageSize: 15 });
    expect(result.hits.map((hit) => hit.object.id)).toEqual([external.id]);
    expect(result.hits[0].object.type).toBe("work");
    expect(internal.id).not.toBe(external.id);
  });

  it("没有 dataset 时返回空结果且不发起检索", async () => {
    const gateway = new FakeSearchGateway();

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "任意", mode: "semantic" },
      { client: gateway, env: { RAGFLOW_DATASET_NAME: "missing" } },
    );

    expect(result.hits).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.semantic.status).toBe("no_dataset");
    expect(gateway.retrieveCalls).toHaveLength(0);
  });

  it("limit 控制返回条数", async () => {
    await seedRef(OWNER, "doc_1");
    await seedRef(OWNER, "doc_2");
    await seedRef(OWNER, "doc_3");

    const gateway = new FakeSearchGateway();
    gateway.chunks = [chunk("doc_1"), chunk("doc_2"), chunk("doc_3")];

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "内容", limit: 2, mode: "semantic" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(result.hits).toHaveLength(2);
    expect(result.total).toBe(2);
  });
});

describe("词法检索（mode=lexical）", () => {
  it("中文 2 字子串命中标题，完全不调用 RAGFlow", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "个人知识系统的搭建",
      library: "internal",
    });
    const gateway = new FakeSearchGateway();

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "知识", mode: "lexical" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(result.mode).toBe("lexical");
    expect(result.hits.map((hit) => hit.object.id)).toEqual([object.id]);
    expect(result.hits[0]).toMatchObject({
      source: "lexical",
      similarity: null,
      chunkId: null,
      documentId: null,
    });
    expect(result.hits[0].matchedFields).toContain("title");
    expect(gateway.listCalls).toBe(0);
    expect(gateway.retrieveCalls).toHaveLength(0);
  });

  it("多词 AND、字段前缀与排除", async () => {
    const target = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "知识管理系统",
      description: "用于复盘和写作",
      library: "internal",
    });
    await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "知识管理草稿",
      description: "复盘中的草稿",
      library: "internal",
    });

    const all = await searchContent(handle.db, OWNER, {
      question: "知识 系统",
      mode: "lexical",
    });
    expect(all.hits.map((hit) => hit.object.id)).toEqual([target.id]);

    const byField = await searchContent(handle.db, OWNER, {
      question: "title:知识",
      mode: "lexical",
    });
    expect(byField.total).toBe(2);

    const excluded = await searchContent(handle.db, OWNER, {
      question: "知识 -草稿",
      mode: "lexical",
    });
    expect(excluded.hits.map((hit) => hit.object.id)).toEqual([target.id]);
  });

  it("分类与标签按名称命中，命名改后立即可搜", async () => {
    const tag = createTag(handle.db, actor(OWNER), { label: "工具类" });
    const object = await createObject(handle.db, actor(OWNER), {
      type: "work",
      title: "课程复盘",
      library: "internal",
      category: "course",
      tags: [tag.label],
    });

    const byCategory = await searchContent(handle.db, OWNER, {
      question: "分类:课程",
      mode: "lexical",
    });
    expect(byCategory.hits.map((hit) => hit.object.id)).toEqual([object.id]);
    expect(byCategory.hits[0].matchedFields).toContain("category");

    const byTag = await searchContent(handle.db, OWNER, {
      question: "标签:工具类",
      mode: "lexical",
    });
    expect(byTag.hits.map((hit) => hit.object.id)).toEqual([object.id]);
    expect(byTag.hits[0].matchedFields).toContain("tag");
  });

  it("全角 / 大小写 / 连续空格归一化后命中同一对象", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "ＡＢＣ  复盘  模板",
      library: "internal",
    });

    for (const question of ["abc 复盘", "ABC   复盘", "ａｂｃ"]) {
      const result = await searchContent(handle.db, OWNER, { question, mode: "lexical" });
      expect(result.hits.map((hit) => hit.object.id)).toEqual([object.id]);
    }
  });

  it("按权重排序：标题完全相等 > 前缀 > 包含 > 标签 > 描述", async () => {
    const exact = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "复盘",
      library: "internal",
    });
    const prefix = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "复盘模板",
      library: "internal",
    });
    const contains = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "如何复盘",
      library: "internal",
    });
    const described = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "随手记",
      description: "关于复盘的一段描述",
      library: "internal",
    });

    const result = await searchContent(handle.db, OWNER, { question: "复盘", mode: "lexical" });

    expect(result.hits.map((hit) => hit.object.id)).toEqual([
      exact.id,
      prefix.id,
      contains.id,
      described.id,
    ]);
    expect(result.hits.map((hit) => hit.score)).toEqual([100, 90, 80, 20]);
  });

  it("对象级去重、归档 / 软删 / 他人对象不出现", async () => {
    const mine = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "复盘方法",
      library: "internal",
    });
    const archived = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "复盘归档",
      library: "internal",
    });
    await setObjectArchived(handle.db, actor(OWNER), archived.id, { archived: true });
    const deleted = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "复盘删除",
      library: "internal",
    });
    await new SqliteObjectRepository(handle.db).softDelete(deleted.id);
    await createObject(handle.db, actor(OTHER), {
      type: "asset",
      title: "复盘他人",
      library: "internal",
    });

    const result = await searchContent(handle.db, OWNER, { question: "复盘", mode: "lexical" });

    expect(result.hits.map((hit) => hit.object.id)).toEqual([mine.id]);
    expect(result.total).toBe(1);
  });

  it("少于 2 字返回空结果与提示，不发起任何查询", async () => {
    const gateway = new FakeSearchGateway();
    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "复" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(result.hits).toEqual([]);
    expect(result.lexical.hint).toBe("至少输入 2 个字");
    expect(gateway.listCalls).toBe(0);
    expect(gateway.retrieveCalls).toHaveLength(0);
  });

  it("语法错误抛 QUERY_SYNTAX 并带位置", async () => {
    for (const question of ["复盘 OR 写作", "复盘 (写作)", '"未闭合', "复盘 -"]) {
      await expect(
        searchContent(handle.db, OWNER, { question, mode: "lexical" }),
      ).rejects.toBeInstanceOf(QuerySyntaxError);
    }

    await expect(
      searchContent(handle.db, OWNER, { question: "复盘 OR 写作", mode: "lexical" }),
    ).rejects.toMatchObject({ code: "QUERY_SYNTAX", details: { position: 3 } });
  });
});

describe("混合检索（默认 hybrid）", () => {
  it("词法与语义按对象合并，同一对象只出一条并标记 both", async () => {
    const object = await seedRef(OWNER, "doc_both", "复盘方法论");
    await seedRef(OWNER, "doc_semantic_only", "完全无关的标题");

    const gateway = new FakeSearchGateway();
    gateway.chunks = [chunk("doc_semantic_only"), chunk("doc_both")];

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "复盘" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(result.mode).toBe("hybrid");
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].object.id).toBe(object.id);
    expect(result.hits[0].source).toBe("both");
    expect(result.hits[0].matchedFields).toContain("title");
    expect(result.hits[1].source).toBe("semantic");
    expect(result.total).toBe(2);
    expect(result.counts).toMatchObject({ lexical: 1, semantic: 2, merged: 2 });
  });

  it("语义对象级去重：同一对象的多个 chunk 合并并记录 chunkCount", async () => {
    await seedRef(OWNER, "doc_multi", "复盘多段");

    const gateway = new FakeSearchGateway();
    gateway.chunks = [
      { ...chunk("doc_multi", "第一段"), id: "chunk_a", similarity: 0.5 },
      { ...chunk("doc_multi", "第二段"), id: "chunk_b", similarity: 0.9 },
    ];

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "正文话题" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].chunkCount).toBe(2);
    expect(result.hits[0].similarity).toBe(0.9);
  });

  it("语义超时只降级不报错，词法结果完整返回", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "复盘模板",
      library: "internal",
    });

    const gateway = new FakeSearchGateway();
    gateway.hang = true;

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "复盘" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" }, semanticTimeoutMs: 20 },
    );

    expect(result.semantic.status).toBe("timeout");
    expect(result.hits.map((hit) => hit.object.id)).toEqual([object.id]);
    expect(result.hits[0].source).toBe("lexical");
  });

  it("语义不可用时 status=unavailable，关键词结果照常返回", async () => {
    await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "复盘模板",
      library: "internal",
    });

    const gateway = new FakeSearchGateway();
    gateway.failList = new Error("connect ECONNREFUSED");

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "复盘" },
      { client: gateway, env: { RAGFLOW_DATASET_NAME: "demo" } },
    );

    expect(result.semantic.status).toBe("unavailable");
    expect(result.total).toBe(1);
  });

  it("响应保留旧键并新增来源字段", async () => {
    const object = await seedRef(OWNER, "doc_shape", "复盘形状");

    const gateway = new FakeSearchGateway();
    gateway.chunks = [chunk("doc_shape")];

    const result = await searchContent(
      handle.db,
      OWNER,
      { question: "复盘" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(result.hits[0]).toEqual(
      expect.objectContaining({
        chunkId: expect.anything(),
        content: expect.any(String),
        highlight: expect.anything(),
        similarity: expect.any(Number),
        documentId: "doc_shape",
        documentName: "doc_shape.txt",
        refId: expect.any(String),
        role: expect.any(String),
        source: "both",
        score: expect.any(Number),
        matchedFields: expect.any(Array),
        chunkCount: 1,
        object: expect.objectContaining({ id: object.id, category: null, tags: [] }),
      }),
    );
    expect(result.library).toBeNull();
  });
});
