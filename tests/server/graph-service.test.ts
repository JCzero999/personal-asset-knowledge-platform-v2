import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  LightragDeleteResult,
  LightragDocument,
  LightragDocumentPage,
  LightragSubgraph,
} from "../../src/server/adapters/lightrag";
import type { RagflowChunkPage } from "../../src/server/adapters/ragflow";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteContentStore } from "../../src/server/repositories/sqlite-content-store";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import {
  describeGraphFailure,
  graphObjectStateOf,
  graphStatus,
  retryGraphObjects,
  waitForGraphDocumentsDeleted,
  type GraphGateway,
  type GraphOptions,
  type RagflowContentGateway,
} from "../../src/server/services/graph-service";

/**
 * 图谱进度与重试的服务层测试：LightRAG / RAGFlow 全部用假网关，数据库用内存 SQLite。
 * 覆盖：失败原因映射、四态收敛（含 parsing / analyzing）、对象维度去重、只重试失败对象。
 */

const OWNER = "user_graph";
const OTHER = "user_other";

let handle: DatabaseHandle;
let objects: SqliteObjectRepository;
let store: SqliteContentStore;

class FakeGraphClient implements GraphGateway {
  documents: LightragDocument[] = [];
  inserted: Array<{ text: string; fileSource: string }> = [];
  deleted: string[][] = [];
  insertError: Error | null = null;
  /** 默认模拟「删除已排上、且旧记录立刻消失」；改成 busy 可测被拒绝的分支。 */
  deleteResult: LightragDeleteResult = { status: "deletion_started", message: "" };
  /** 模拟后台删除迟迟不完成：旧记录留在列表里。 */
  keepDocumentsAfterDelete = false;

  async insertText(input: { text: string; fileSource: string }): Promise<void> {
    if (this.insertError) throw this.insertError;
    this.inserted.push(input);
  }

  async listDocuments(page = 1, pageSize = 50): Promise<LightragDocumentPage> {
    const start = (page - 1) * pageSize;
    return {
      documents: this.documents.slice(start, start + pageSize),
      total: this.documents.length,
    };
  }

  async deleteDocuments(docIds: string[]): Promise<LightragDeleteResult> {
    this.deleted.push([...docIds]);
    if (this.deleteResult.status === "deletion_started" && !this.keepDocumentsAfterDelete) {
      this.documents = this.documents.filter((doc) => !docIds.includes(doc.id));
    }
    return this.deleteResult;
  }

  async query(): Promise<{
    response: string;
    references: Array<{ referenceId: string; filePath: string }>;
  }> {
    return { response: "", references: [] };
  }

  async listLabels(): Promise<string[]> {
    return [];
  }

  async getSubgraph(): Promise<LightragSubgraph> {
    return { nodes: [], edges: [] };
  }
}

class FakeContent implements RagflowContentGateway {
  private readonly chunks = new Map<string, string>();

  set(documentId: string, content: string): void {
    this.chunks.set(documentId, content);
  }

  async listChunks(
    _datasetId: string,
    documentId: string,
  ): Promise<RagflowChunkPage> {
    const content = this.chunks.get(documentId);
    return {
      chunks: content === undefined ? [] : [{ id: `chunk-${documentId}`, content }],
      total: content === undefined ? 0 : 1,
    };
  }
}

interface DocOptions {
  docId: string;
  objectId: string;
  status: string;
  error?: string | null;
  chunks?: number;
  updatedAt?: string;
  hash?: string;
}

function doc(options: DocOptions): LightragDocument {
  return {
    id: options.docId,
    filePath: `pakp:obj:${options.objectId}:${options.hash ?? "aaaa1111bbbb"}`,
    status: options.status,
    chunksCount: options.chunks ?? 1,
    errorMessage: options.error ?? null,
    updatedAt: options.updatedAt ?? "2026-11-13T09:00:00.000Z",
  };
}

async function seedWork(title: string, ownerSub = OWNER, withContent = true) {
  const work = await objects.create({
    type: "work",
    title,
    // 作品只存在于外库（ADR-029）；LightRAG 构图与库别无关。
    library: "external",
    category: "article",
    ownerSub,
  });

  if (withContent) {
    await store.upsert({
      ownerType: "work",
      ownerId: work.id,
      datasetId: "ds_1",
      documentId: `ragflow-${work.id}`,
      contentKey: `obj:${work.id}:primary`,
      role: "primary",
      documentName: `${title}.md`,
      mime: "text/markdown",
      sizeBytes: 32,
      parseStatus: "succeeded",
      syncState: "synced",
    });
  }

  return work;
}

function contentFor(workId: string): FakeContent {
  const content = new FakeContent();
  content.set(`ragflow-${workId}`, `${workId} 的正文`);
  return content;
}

function options(client: FakeGraphClient, content: FakeContent): GraphOptions {
  // LightRAG 的删除是后台任务；单测不等真实时钟，轮询一次即可。
  return {
    client,
    content,
    deleteWait: { budgetMs: 0, intervalMs: 0, sleep: async () => {} },
    // 模型端点探测不打网络：默认固定「可达」，需要断言的用例自己注入。
    diagnosis: {
      config: { provider: "openai", baseUrl: "https://probe.invalid/v1", apiKey: "" },
      fetch: async () => ({ status: 200 }),
      cache: null,
    },
  };
}

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
  objects = new SqliteObjectRepository(handle.db);
  store = new SqliteContentStore(handle.db);
});

afterAll(() => {
  handle.close();
});

describe("describeGraphFailure", () => {
  it("空原因与只有 chunk 前缀的串落到「未返回原因」，原始串保留", () => {
    expect(describeGraphFailure(null)).toEqual({
      message: "抽取失败（未返回原因）",
      raw: null,
    });
    expect(describeGraphFailure("   ")).toEqual({
      message: "抽取失败（未返回原因）",
      raw: null,
    });

    const raw = "C[1/4]: doc-fdf94f61ba89afc7349d5d5a9788c4d9-chunk-000: ";
    expect(describeGraphFailure(raw)).toEqual({
      message: "抽取失败（未返回原因）",
      raw: raw.trim(),
    });
  });

  it("超时映射为「抽取超时：本地模型过慢」", () => {
    const raw = "C[1/29]: httpx.ReadTimeout: doc-abc-chunk-001: ";
    expect(describeGraphFailure(raw).message).toBe("抽取超时：本地模型过慢");
    expect(describeGraphFailure("APITimeout: upstream request timeout").message).toBe(
      "抽取超时：本地模型过慢",
    );
  });

  it("连接失败 / 鉴权 / 限流各有可读原因", () => {
    expect(describeGraphFailure("httpx.ConnectError: connection refused").message).toContain(
      "连接失败",
    );
    expect(describeGraphFailure("Error code: 401 invalid api key").message).toContain("密钥");
    expect(describeGraphFailure("Error code: 429 rate limit reached").message).toContain(
      "限流",
    );
  });

  it("其余原始原因去掉 chunk 前缀后保留首行", () => {
    const reason = describeGraphFailure(
      "C[2/3]: doc-x-chunk-002: LightRAG 返回 500\nextra detail",
    );
    expect(reason.message).toBe("抽取失败：LightRAG 返回 500");
    expect(reason.raw).toContain("extra detail");
  });

  it("不可解析的串按未返回原因处理，不臆造", () => {
    expect(describeGraphFailure("   :   ").message).toBe("抽取失败（未返回原因）");
  });
});

describe("graphObjectStateOf", () => {
  it("parsing / analyzing / processing 都算抽取中", () => {
    expect(graphObjectStateOf(["parsing"])).toBe("extracting");
    expect(graphObjectStateOf(["analyzing"])).toBe("extracting");
    expect(graphObjectStateOf(["processing"])).toBe("extracting");
    expect(graphObjectStateOf(["PENDING"])).toBe("queued");
    expect(graphObjectStateOf(["processed"])).toBe("processed");
    expect(graphObjectStateOf(["failed"])).toBe("failed");
  });

  it("多版本按「进行中 > 已完成 > 排队 > 失败」收敛", () => {
    expect(graphObjectStateOf(["failed", "processing"])).toBe("extracting");
    expect(graphObjectStateOf(["failed", "processed"])).toBe("processed");
    expect(graphObjectStateOf(["failed", "pending"])).toBe("queued");
    expect(graphObjectStateOf([])).toBe("unknown");
    expect(graphObjectStateOf(["mystery"])).toBe("unknown");
  });
});

describe("graphStatus", () => {
  it("按对象汇总四态：历史版本只算一次，失败原因可读", async () => {
    const extracting = await seedWork("正在抽取的作品");
    const failed = await seedWork("失败的作品");
    const done = await seedWork("已完成的作品");

    const client = new FakeGraphClient();
    client.documents = [
      // 同一对象的旧版本（失败）+ 新版本（processing）：应显示为「抽取中」。
      doc({
        docId: "doc-old",
        objectId: extracting.id,
        status: "failed",
        error: "C[1/2]: doc-old-chunk-000: ",
        updatedAt: "2026-11-12T10:00:00.000Z",
      }),
      doc({
        docId: "doc-new",
        objectId: extracting.id,
        status: "processing",
        updatedAt: "2026-11-13T10:00:00.000Z",
      }),
      doc({
        docId: "doc-failed",
        objectId: failed.id,
        status: "failed",
        error: "C[1/29]: doc-failed-chunk-001: ",
        chunks: 29,
      }),
      doc({ docId: "doc-done", objectId: done.id, status: "processed" }),
      // 不属于当前账号的文档：不进入统计（ADR-011）。
      doc({ docId: "doc-other", objectId: "obj-not-owned", status: "failed" }),
    ];

    const status = await graphStatus(handle.db, OWNER, options(client, new FakeContent()));

    expect(status.total).toBe(3);
    expect(status.counts).toEqual({
      processed: 1,
      extracting: 1,
      queued: 0,
      failed: 1,
      unknown: 0,
    });
    expect(status.failed).toEqual([
      { objectId: failed.id, error: "抽取失败（未返回原因）" },
    ]);

    const extractingRow = status.objects.find((row) => row.objectId === extracting.id);
    expect(extractingRow?.state).toBe("extracting");
    expect(extractingRow?.status).toBe("processing");
    expect(extractingRow?.title).toBe("正在抽取的作品");

    const failedRow = status.objects.find((row) => row.objectId === failed.id);
    expect(failedRow?.state).toBe("failed");
    expect(failedRow?.error).toBe("抽取失败（未返回原因）");
    expect(failedRow?.errorRaw).toBe("C[1/29]: doc-failed-chunk-001:");
    expect(failedRow?.chunksCount).toBe(29);
    expect(failedRow?.title).toBe("失败的作品");

    expect(status.objects.find((row) => row.objectId === done.id)?.state).toBe("processed");
  });

  it("同一对象的两个失败版本只产生一行失败记录", async () => {
    const duplicate = await seedWork("重复版本的作品");

    const client = new FakeGraphClient();
    client.documents = [
      doc({
        docId: "doc-a",
        objectId: duplicate.id,
        status: "failed",
        error: "C[1/4]: doc-a-chunk-000: ",
        updatedAt: "2026-11-12T10:00:00.000Z",
        hash: "1111",
      }),
      doc({
        docId: "doc-b",
        objectId: duplicate.id,
        status: "failed",
        error: "C[1/4]: doc-b-chunk-000: ",
        updatedAt: "2026-11-13T10:00:00.000Z",
        hash: "2222",
      }),
    ];

    const status = await graphStatus(handle.db, OWNER, options(client, new FakeContent()));

    expect(status.total).toBe(1);
    expect(status.counts.failed).toBe(1);
    expect(status.failed).toHaveLength(1);
    // 同对象取最新版本（doc-b）作为代表文档。
    expect(status.objects[0].docId).toBe("doc-b");
  });
});

describe("graphStatus 模型端点探测", () => {
  /** Node fetch 的连接拒绝长这样：TypeError("fetch failed") + cause.code。 */
  function connectionRefused(): Error {
    const error = new TypeError("fetch failed");
    (error as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    return error;
  }

  async function failedWorkWithDocs() {
    const failed = await seedWork("探测用途的作品");
    const client = new FakeGraphClient();
    client.documents = [
      doc({
        docId: "doc-probe-failed",
        objectId: failed.id,
        status: "failed",
        error: "C[1/29]: doc-probe-failed-chunk-001: ",
      }),
    ];
    return { failed, client };
  }

  it("有失败对象时探测端点：可达就给中性结论，且响应里不出现密钥", async () => {
    const { client } = await failedWorkWithDocs();
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    const status = await graphStatus(handle.db, OWNER, {
      ...options(client, new FakeContent()),
      diagnosis: {
        config: {
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com/v1/",
          apiKey: "sk-live-abcdef123456",
        },
        fetch: async (url, init) => {
          seen.push({ url, headers: init.headers });
          return { status: 200 };
        },
        cache: null,
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.deepseek.com/v1/models");
    expect(seen[0].headers.authorization).toBe("Bearer sk-live-abcdef123456");
    expect(status.diagnosis?.ok).toBe(true);
    expect(status.diagnosis?.message).toContain("可连接");
    expect(status.diagnosis?.message).toContain("抽取仍然失败");
    expect(status.diagnosis?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(status.diagnosis?.checkedAt ?? ""))).toBe(false);

    // 整个响应体（页面会原样拿到）不得出现明文密钥。
    expect(JSON.stringify(status)).not.toContain("sk-live-abcdef123456");
  });

  it("端点连不上时给出可判定结论，status 本身不失败", async () => {
    const { client } = await failedWorkWithDocs();

    const status = await graphStatus(handle.db, OWNER, {
      ...options(client, new FakeContent()),
      diagnosis: {
        config: {
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          apiKey: "ollama",
        },
        fetch: async () => {
          throw connectionRefused();
        },
        cache: null,
      },
    });

    expect(status.counts.failed).toBe(1);
    expect(status.diagnosis?.ok).toBe(false);
    expect(status.diagnosis?.message).toContain("连接被拒绝");
    expect(status.diagnosis?.message).toContain("127.0.0.1:11434");
  });

  it("探测超时降级成「探测超时」，不抛错", async () => {
    const { client } = await failedWorkWithDocs();
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";

    const status = await graphStatus(handle.db, OWNER, {
      ...options(client, new FakeContent()),
      diagnosis: {
        config: { provider: "openai", baseUrl: "https://slow.invalid/v1", apiKey: "" },
        timeoutMs: 3_000,
        fetch: async () => {
          throw timeout;
        },
        cache: null,
      },
    });

    expect(status.diagnosis?.ok).toBe(false);
    expect(status.diagnosis?.message).toContain("探测超时");
  });

  it("没有失败对象时不探测，diagnosis 为 null", async () => {
    const done = await seedWork("已经抽好的作品");
    const client = new FakeGraphClient();
    client.documents = [doc({ docId: "doc-ok", objectId: done.id, status: "processed" })];

    let calls = 0;
    const status = await graphStatus(handle.db, OWNER, {
      ...options(client, new FakeContent()),
      diagnosis: {
        config: { provider: "openai", baseUrl: "https://probe.invalid/v1", apiKey: "" },
        fetch: async () => {
          calls += 1;
          return { status: 200 };
        },
        cache: null,
      },
    });

    expect(calls).toBe(0);
    expect(status.diagnosis).toBeNull();
  });

  it("显式传 diagnosis: null 可关闭探测（既有调用方与离线环境）", async () => {
    const { client } = await failedWorkWithDocs();

    const status = await graphStatus(handle.db, OWNER, {
      ...options(client, new FakeContent()),
      diagnosis: null,
    });

    expect(status.diagnosis).toBeNull();
    expect(status.counts.failed).toBe(1);
  });
});

describe("retryGraphObjects", () => {
  it("只重建失败对象：先删旧版本再按同步口径重新入库", async () => {
    const failed = await seedWork("要重试的作品");
    const done = await seedWork("已完成的作品");

    const client = new FakeGraphClient();
    client.documents = [
      doc({ docId: "doc-f1", objectId: failed.id, status: "failed", error: "C[1/2]: x: ", hash: "1111" }),
      doc({ docId: "doc-f2", objectId: failed.id, status: "failed", error: "C[2/2]: x: ", hash: "2222" }),
      doc({ docId: "doc-ok", objectId: done.id, status: "processed" }),
    ];

    const content = contentFor(failed.id);
    content.set(`ragflow-${done.id}`, "已完成的正文");

    const result = await retryGraphObjects(
      handle.db,
      OWNER,
      [failed.id, done.id],
      options(client, content),
    );

    expect(result.requested).toBe(2);
    expect(result.resubmitted).toBe(1);
    expect(result.results.map((item) => item.outcome)).toEqual(["resubmitted", "skipped"]);
    expect(result.results[1].message).toContain("已经完成抽取");

    // 只删失败对象的两份旧文档；processed 对象一个都不碰。
    expect(client.deleted).toEqual([["doc-f1", "doc-f2"]]);
    expect(client.inserted).toHaveLength(1);
    expect(client.inserted[0].text).toContain("《要重试的作品》");
    expect(client.inserted[0].text).toContain("正文：");
    expect(client.inserted[0].fileSource).toMatch(
      new RegExp(`^pakp:obj:${failed.id}:[0-9a-f]{12}$`),
    );
  });

  it("不属于当前账号的对象、没有失败记录的对象都如实回显", async () => {
    const foreign = await seedWork("别人的作品", OTHER);
    const done = await seedWork("已完成的作品");

    const client = new FakeGraphClient();
    client.documents = [
      doc({ docId: "doc-foreign", objectId: foreign.id, status: "failed", error: "x: " }),
      doc({ docId: "doc-ok", objectId: done.id, status: "processed" }),
    ];

    const result = await retryGraphObjects(
      handle.db,
      OWNER,
      [foreign.id, done.id, "obj-missing"],
      options(client, new FakeContent()),
    );

    expect(result.resubmitted).toBe(0);
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].message).toContain("不属于当前账号");
    expect(result.results[2].outcome).toBe("failed");
    expect(client.deleted).toHaveLength(0);
    expect(client.inserted).toHaveLength(0);
  });

  it("抽取中的对象不被打断", async () => {
    const running = await seedWork("正在抽取的作品");

    const client = new FakeGraphClient();
    client.documents = [
      doc({ docId: "doc-run", objectId: running.id, status: "analyzing" }),
    ];

    const result = await retryGraphObjects(
      handle.db,
      OWNER,
      [running.id],
      options(client, new FakeContent()),
    );

    expect(result.results[0]).toMatchObject({ outcome: "skipped" });
    expect(result.results[0].message).toContain("正在抽取");
    expect(client.deleted).toHaveLength(0);
  });

  it("没有正文的失败对象不重新入库", async () => {
    const empty = await seedWork("没有正文的作品", OWNER, false);

    const client = new FakeGraphClient();
    client.documents = [
      doc({ docId: "doc-empty", objectId: empty.id, status: "failed", error: "x: " }),
    ];

    const result = await retryGraphObjects(
      handle.db,
      OWNER,
      [empty.id],
      options(client, new FakeContent()),
    );

    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].message).toContain("先完成内容解析");
    expect(client.inserted).toHaveLength(0);
  });

  it("入库失败回显为 failed，不影响其他对象", async () => {
    const target = await seedWork("入库会失败的作品");

    const client = new FakeGraphClient();
    client.documents = [
      doc({ docId: "doc-x", objectId: target.id, status: "failed", error: "x: " }),
    ];
    client.insertError = new Error("LightRAG 返回 503");

    const result = await retryGraphObjects(
      handle.db,
      OWNER,
      [target.id],
      options(client, contentFor(target.id)),
    );

    expect(result.resubmitted).toBe(0);
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].message).toContain("503");
  });

  it("objectIds 为空或超过上限时拒绝", async () => {
    await expect(
      retryGraphObjects(handle.db, OWNER, [], options(new FakeGraphClient(), new FakeContent())),
    ).rejects.toThrow("至少选择一个");

    const tooMany = Array.from({ length: 21 }, (_value, index) => `obj-${index}`);
    await expect(
      retryGraphObjects(
        handle.db,
        OWNER,
        tooMany,
        options(new FakeGraphClient(), new FakeContent()),
      ),
    ).rejects.toThrow("一次最多重新抽取");
  });

  it("旧版本删不掉（LightRAG 忙）时如实回显，不假装已提交", async () => {
    const target = await seedWork("删除会被拒的作品");

    const client = new FakeGraphClient();
    client.documents = [
      doc({ docId: "doc-busy", objectId: target.id, status: "failed", error: "x: " }),
    ];
    client.deleteResult = { status: "busy", message: "Pipeline is busy" };

    const result = await retryGraphObjects(
      handle.db,
      OWNER,
      [target.id],
      options(client, contentFor(target.id)),
    );

    expect(result.resubmitted).toBe(0);
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].message).toContain("LightRAG 正忙");
    expect(client.inserted).toHaveLength(0);
  });

  it("后台删除没在预算内完成：不抢着重入，提示稍后再试", async () => {
    const target = await seedWork("旧版本还在删的作品");

    const client = new FakeGraphClient();
    client.documents = [
      doc({ docId: "doc-slow", objectId: target.id, status: "failed", error: "x: " }),
    ];
    client.keepDocumentsAfterDelete = true;

    const result = await retryGraphObjects(
      handle.db,
      OWNER,
      [target.id],
      options(client, contentFor(target.id)),
    );

    expect(result.resubmitted).toBe(0);
    expect(result.results[0].outcome).toBe("failed");
    expect(result.results[0].message).toContain("后台删除");
    expect(client.inserted).toHaveLength(0);
  });
});

describe("waitForGraphDocumentsDeleted", () => {
  it("旧记录一消失就返回 gone，不空等", async () => {
    const client = new FakeGraphClient();
    client.documents = [
      doc({ docId: "doc-1", objectId: "obj-wait", status: "failed" }),
    ];
    await client.deleteDocuments(["doc-1"]);

    const waited = await waitForGraphDocumentsDeleted(client, ["doc-1"], {
      sleep: async () => {
        throw new Error("不该再等");
      },
    });

    expect(waited).toEqual({ gone: true, remaining: [] });
  });

  it("预算用完仍在就返回剩余 id，不会无限轮询", async () => {
    const client = new FakeGraphClient();
    client.documents = [
      doc({ docId: "doc-1", objectId: "obj-wait", status: "failed" }),
    ];

    let sleeps = 0;
    const waited = await waitForGraphDocumentsDeleted(client, ["doc-1", "doc-2"], {
      budgetMs: 6,
      intervalMs: 3,
      sleep: async () => {
        sleeps += 1;
      },
      now: () => sleeps * 3,
    });

    // doc-2 本来就不在列表里，只剩 doc-1 没删掉。
    expect(waited).toEqual({ gone: false, remaining: ["doc-1"] });
    expect(sleeps).toBe(2);
  });

  it("空列表直接算完成", async () => {
    const waited = await waitForGraphDocumentsDeleted(new FakeGraphClient(), []);
    expect(waited).toEqual({ gone: true, remaining: [] });
  });
});
