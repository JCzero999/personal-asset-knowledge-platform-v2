import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ValidationError } from "../../src/domain/errors";
import type {
  RagflowChunk,
  RagflowDataset,
  RagflowRetrievalResult,
} from "../../src/server/adapters/ragflow";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteContentStore } from "../../src/server/repositories/sqlite-content-store";
import { createObject, setObjectArchived } from "../../src/server/services/object-service";
import {
  parseSearchQuery,
  searchContent,
  type SearchGateway,
} from "../../src/server/services/search-service";

/**
 * 检索服务测试：RAGFlow 召回用假网关，重点验证业务过滤
 * （归属、归档、库别）不会被检索层绕过。
 */

const OWNER = "user_1";
const OTHER = "user_2";

let handle: DatabaseHandle;
let store: SqliteContentStore;

class FakeSearchGateway implements SearchGateway {
  datasets: RagflowDataset[] = [];
  chunks: RagflowChunk[] = [];
  retrieveCalls: { question: string; datasetIds: string[]; pageSize?: number }[] = [];
  failList: Error | null = null;

  async listDatasets(): Promise<RagflowDataset[]> {
    if (this.failList) throw this.failList;
    return this.datasets;
  }

  async retrieve(input: {
    question: string;
    datasetIds: string[];
    pageSize?: number;
  }): Promise<RagflowRetrievalResult> {
    this.retrieveCalls.push(input);
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

async function seedRef(ownerSub: string, documentId: string) {
  const object = await createObject(handle.db, ownerSub, {
    type: "asset",
    title: `对象 ${documentId}`,
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
    DELETE FROM sync_jobs;
    DELETE FROM content_refs;
    DELETE FROM objects;
  `);
  store = new SqliteContentStore(handle.db);
});

describe("parseSearchQuery", () => {
  it("解析搜索词、条数、库别与阈值", () => {
    expect(
      parseSearchQuery(
        new URLSearchParams("q= 分布式事务 &limit=5&library=external&threshold=0.3"),
      ),
    ).toEqual({
      question: "分布式事务",
      limit: 5,
      library: "external",
      similarityThreshold: 0.3,
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
  });
});

describe("searchContent", () => {
  it("只返回当前用户未归档对象的命中，并带出对象摘要", async () => {
    const mine = await seedRef(OWNER, "doc_mine");
    const archived = await seedRef(OWNER, "doc_archived");
    await setObjectArchived(handle.db, OWNER, archived.id, { archived: true });
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
      { question: "codename" },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(result.total).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      documentId: "doc_mine",
      documentName: "doc_mine.txt",
      similarity: 0.8,
      object: { id: mine.id, title: "对象 doc_mine", library: "internal", type: "asset" },
    });
  });

  it("按库别过滤，并在过滤前多召回一些", async () => {
    const internal = await seedRef(OWNER, "doc_internal");
    const external = await createObject(handle.db, OWNER, {
      type: "work",
      title: "外库作品",
      library: "external",
      format: "article",
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
      { question: "课", library: "external", limit: 5 },
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
      { question: "任意" },
      { client: gateway, env: { RAGFLOW_DATASET_NAME: "missing" } },
    );

    expect(result).toEqual({ question: "任意", hits: [], total: 0 });
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
      { question: "内容", limit: 2 },
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(result.hits).toHaveLength(2);
    expect(result.total).toBe(2);
  });
});
