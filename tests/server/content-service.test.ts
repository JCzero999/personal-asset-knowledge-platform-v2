import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actor } from "../helpers/actor";

import { DomainError, NotFoundError, ValidationError } from "../../src/domain/errors";
import type { RagflowDataset } from "../../src/server/adapters/ragflow";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteContentStore } from "../../src/server/repositories/sqlite-content-store";
import {
  DEFAULT_DATASET_NAME,
  MAX_CONTENT_BYTES,
  downloadObjectContent,
  uploadObjectContent,
  type ContentDownloadGateway,
  type ContentGateway,
} from "../../src/server/services/content-service";
import { createObject } from "../../src/server/services/object-service";

/**
 * 上传服务测试：RAGFlow 全部用假网关，数据库用内存 SQLite。
 * 这里验证的是业务契约（归属、校验、替换、落库、入队），真实 HTTP 契约在
 * adapters/ragflow 的单测与 docs/04_INTEGRATION.md 的实测记录里。
 */

const OWNER = "user_1";
const OTHER = "user_2";

let handle: DatabaseHandle;
let store: SqliteContentStore;

/** 记录调用的假网关，行为贴近 v0.20.5 实测：删不存在的文档会报 NotFound。 */
class FakeGateway implements ContentGateway {
  datasets: RagflowDataset[] = [];
  documents: { id: string; datasetId: string; filename: string }[] = [];
  deleted: { datasetId: string; ids: string[] }[] = [];
  renamed: { id: string; name: string }[] = [];
  metaByDocument = new Map<string, Record<string, string>>();
  parseStarted: { datasetId: string; ids: string[] }[] = [];
  createDatasetCalls: { name: string }[] = [];
  createDocumentCalls = 0;
  failCreateDocument: Error | null = null;
  failMetaUpdate: Error | null = null;
  failStartParsing: Error | null = null;

  async listDatasets(query?: { name?: string }): Promise<RagflowDataset[]> {
    const name = query?.name;
    return this.datasets.filter((dataset) => !name || dataset.name === name);
  }

  async createDataset(input: { name: string; description?: string }): Promise<RagflowDataset> {
    this.createDatasetCalls.push({ name: input.name });
    const dataset: RagflowDataset = {
      id: `ds_${this.datasets.length + 1}`,
      name: input.name,
      description: input.description ?? null,
      embeddingModel: null,
      documentCount: 0,
      chunkCount: 0,
      createdAt: null,
      updatedAt: null,
    };
    this.datasets.push(dataset);
    return dataset;
  }

  async createDocument(
    datasetId: string,
    input: { filename: string },
  ): Promise<{ id: string }> {
    if (this.failCreateDocument) {
      throw this.failCreateDocument;
    }
    this.createDocumentCalls += 1;
    const id = `doc_${this.createDocumentCalls}`;
    this.documents.push({ id, datasetId, filename: input.filename });
    return { id };
  }

  async deleteDocument(datasetId: string, documentIds: string | string[]): Promise<void> {
    const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
    const missing = ids.filter((id) => !this.documents.some((doc) => doc.id === id));
    if (missing.length > 0) {
      throw new NotFoundError(`Documents not found: ${missing.join(",")}`);
    }
    this.documents = this.documents.filter((doc) => !ids.includes(doc.id));
    this.deleted.push({ datasetId, ids });
  }

  async updateDocumentMetaFields(
    _datasetId: string,
    documentId: string,
    metaFields: Record<string, string>,
  ): Promise<void> {
    if (this.failMetaUpdate) {
      throw this.failMetaUpdate;
    }
    this.metaByDocument.set(documentId, { ...metaFields });
  }

  async renameDocument(
    _datasetId: string,
    documentId: string,
    name: string,
  ): Promise<void> {
    const doc = this.documents.find((item) => item.id === documentId);
    if (!doc) {
      throw new NotFoundError(`Document not found: ${documentId}`);
    }
    doc.filename = name;
    this.renamed.push({ id: documentId, name });
  }

  async startParsing(datasetId: string, documentIds: string | string[]): Promise<void> {
    if (this.failStartParsing) {
      throw this.failStartParsing;
    }
    this.parseStarted.push({
      datasetId,
      ids: Array.isArray(documentIds) ? documentIds : [documentIds],
    });
  }
}

function formWith(
  file: Blob | null,
  fields: Record<string, string> = {},
): FormData {
  const form = new FormData();
  if (file) {
    form.append("file", file);
  }
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
}

function textFile(content: string, name = "note.txt", type = "text/plain"): File {
  return new File([content], name, { type });
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
    DELETE FROM library_events;
    DELETE FROM objects;
  `);
  store = new SqliteContentStore(handle.db);
});

describe("uploadObjectContent 成功路径", () => {
  it("上传主内容：写 refs、镜像 meta、入队 upsert", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "测试资产",
      library: "internal",
    });
    const gateway = new FakeGateway();

    const ref = await uploadObjectContent(
      handle.db,
      OWNER,
      object.id,
      formWith(textFile("hello ragflow")),
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(ref.ownerType).toBe("asset");
    expect(ref.ownerId).toBe(object.id);
    expect(ref.role).toBe("primary");
    expect(ref.contentKey).toBe(`obj:${object.id}:primary`);
    expect(ref.datasetId).toBe("ds_main");
    expect(ref.documentId).toBe("doc_1");
    expect(ref.documentName).toBe("note.txt");
    expect(ref.mime).toBe("text/plain");
    expect(ref.sizeBytes).toBe(13);
    expect(ref.contentHash).toHaveLength(64);
    expect(ref.syncState).toBe("pending");
    expect(ref.parseStatus).toBe("running");
    expect(gateway.parseStarted).toEqual([{ datasetId: "ds_main", ids: ["doc_1"] }]);

    // 数据库里只有一条引用，且 outbox 里有对应任务。
    const refs = await store.listByOwner("asset", object.id);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe(ref.id);

    const jobs = await store.listPendingJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      ownerType: "asset",
      ownerId: object.id,
      contentRefId: ref.id,
      action: "upsert",
      state: "pending",
    });

    // ADR-007 镜像字段：过滤要用的才写，status 不写。
    expect(gateway.metaByDocument.get("doc_1")).toEqual({
      content_key: `obj:${object.id}:primary`,
      owner_type: "asset",
      owner_id: object.id,
      library: "internal",
      archived: "false",
      source: "handwritten",
    });
  });

  it("作品的 meta 额外镜像 format（值取分类码，契约不变）", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "work",
      title: "一篇文章",
      library: "external",
      category: "article",
      source: "ai_extracted",
    });
    const gateway = new FakeGateway();

    await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("draft")), {
      client: gateway,
      env: { RAGFLOW_DATASET_ID: "ds_main" },
    });

    expect(gateway.metaByDocument.get("doc_1")).toMatchObject({
      owner_type: "work",
      library: "external",
      format: "article",
      source: "ai_extracted",
    });
  });

  it("附件不删除主内容，content_key 每次唯一", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "带附件",
      library: "external",
    });
    const gateway = new FakeGateway();
    const env = { RAGFLOW_DATASET_ID: "ds_main" };

    const primary = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("body")), {
      client: gateway,
      env,
    });
    const first = await uploadObjectContent(
      handle.db,
      OWNER,
      object.id,
      formWith(textFile("a"), { role: "attachment" }),
      { client: gateway, env },
    );
    const second = await uploadObjectContent(
      handle.db,
      OWNER,
      object.id,
      formWith(textFile("b"), { role: "attachment" }),
      { client: gateway, env },
    );

    expect(gateway.deleted).toHaveLength(0);
    expect(first.role).toBe("attachment");
    expect(first.contentKey).toMatch(new RegExp(`^obj:${object.id}:attachment:`));
    expect(second.contentKey).not.toBe(first.contentKey);

    const refs = await store.listByOwner("asset", object.id);
    expect(refs).toHaveLength(3);
    expect((await store.findPrimary("asset", object.id))?.id).toBe(primary.id);
  });
});

describe("uploadObjectContent 校验与归属", () => {
  it("他人对象返回 404，且不调用 RAGFlow", async () => {
    const object = await createObject(handle.db, actor(OTHER), {
      type: "asset",
      title: "别人的",
      library: "internal",
    });
    const gateway = new FakeGateway();

    await expect(
      uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("x")), {
        client: gateway,
        env: { RAGFLOW_DATASET_ID: "ds_main" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(gateway.createDocumentCalls).toBe(0);
    expect(await store.listByOwner("asset", object.id)).toHaveLength(0);
  });

  it("不存在的对象也返回 404", async () => {
    const gateway = new FakeGateway();

    await expect(
      uploadObjectContent(handle.db, OWNER, "01NOSUCHOBJECT", formWith(textFile("x")), {
        client: gateway,
        env: { RAGFLOW_DATASET_ID: "ds_main" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(gateway.createDocumentCalls).toBe(0);
  });

  it("缺文件、空文件、超限文件都返回 400 且不落库", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "校验",
      library: "internal",
    });
    const gateway = new FakeGateway();
    const options = { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } };

    const missing = await uploadObjectContent(handle.db, OWNER, object.id, formWith(null), options)
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ValidationError);
    expect((missing as DomainError).details?.field).toBe("file");

    await expect(
      uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("")), options),
    ).rejects.toBeInstanceOf(ValidationError);

    const tooBig = new File([new Uint8Array(MAX_CONTENT_BYTES + 1)], "big.bin");
    await expect(
      uploadObjectContent(handle.db, OWNER, object.id, formWith(tooBig), options),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(gateway.createDocumentCalls).toBe(0);
    expect(await store.listByOwner("asset", object.id)).toHaveLength(0);
  });

  it("非法 role 与缺扩展名文件名的处理", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "role",
      library: "internal",
    });
    const gateway = new FakeGateway();
    const options = { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } };

    await expect(
      uploadObjectContent(
        handle.db,
        OWNER,
        object.id,
        formWith(textFile("x"), { role: "cover" }),
        options,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // 没有扩展名时补 .txt：RAGFlow 靠后缀选解析器。
    await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("x", "README")), options);
    expect(gateway.documents[0].filename).toBe("README.txt");
  });

  it("documentName 覆盖文件名并过滤路径", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "命名",
      library: "internal",
    });
    const gateway = new FakeGateway();

    const ref = await uploadObjectContent(
      handle.db,
      OWNER,
      object.id,
      formWith(textFile("x"), { documentName: "..\\..\\年报.md" }),
      { client: gateway, env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );

    expect(ref.documentName).toBe("年报.md");
    expect(gateway.documents[0].filename).toBe("年报.md");
  });
});

describe("uploadObjectContent 主内容替换", () => {
  it("替换主内容：新文档先落库，再删旧文档并改回原名", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "替换",
      library: "internal",
    });
    const gateway = new FakeGateway();
    const env = { RAGFLOW_DATASET_ID: "ds_main" };

    const first = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("v1")), {
      client: gateway,
      env,
    });
    const second = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("v2")), {
      client: gateway,
      env,
    });

    // 旧文档最终被删，新文档保留并改回用户的原文件名。
    expect(gateway.deleted).toEqual([{ datasetId: "ds_main", ids: ["doc_1"] }]);
    expect(gateway.documents.map((doc) => doc.id)).toEqual(["doc_2"]);
    expect(gateway.documents[0].filename).toBe("note.txt");
    expect(gateway.renamed).toEqual([{ id: "doc_2", name: "note.txt" }]);

    expect(second.id).toBe(first.id);
    expect(second.contentKey).toBe(first.contentKey);
    expect(second.documentId).toBe("doc_2");
    expect(second.sizeBytes).toBe(2);

    const refs = await store.listByOwner("asset", object.id);
    expect(refs).toHaveLength(1);
    expect(refs[0].documentId).toBe("doc_2");

    // meta 整体重写到新文档上（RAGFlow 的更新是替换不是合并）。
    expect(gateway.metaByDocument.get("doc_2")?.content_key).toBe(first.contentKey);

    // outbox 去重：同一 owner + upsert 只有一条活跃任务。
    const jobs = await store.listPendingJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].contentRefId).toBe(first.id);
  });

  it("多次替换主内容始终只有一条 primary 引用", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "连续替换",
      library: "internal",
    });
    const gateway = new FakeGateway();
    const env = { RAGFLOW_DATASET_ID: "ds_main" };

    const first = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("v1")), {
      client: gateway,
      env,
    });
    const second = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("v2")), {
      client: gateway,
      env,
    });
    const third = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("v3")), {
      client: gateway,
      env,
    });

    const refs = await store.listByOwner("asset", object.id);
    expect(refs).toHaveLength(1);
    expect(refs.filter((ref) => ref.role === "primary")).toHaveLength(1);
    expect(refs[0].id).toBe(first.id);
    expect(refs[0].documentId).toBe(third.documentId);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    // 每次替换都删除上一条文档，RAGFlow 侧不会留下孤儿文件。
    expect(gateway.deleted).toEqual([
      { datasetId: "ds_main", ids: ["doc_1"] },
      { datasetId: "ds_main", ids: ["doc_2"] },
    ]);
    expect(gateway.documents.map((doc) => doc.id)).toEqual(["doc_3"]);
  });

  it("替换时新文档上传失败，旧内容与旧引用保持不变", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "替换失败",
      library: "internal",
    });
    const gateway = new FakeGateway();
    const env = { RAGFLOW_DATASET_ID: "ds_main" };

    const first = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("v1")), {
      client: gateway,
      env,
    });

    gateway.failCreateDocument = new DomainError("INTERNAL", "RAGFlow 不可用");

    await expect(
      uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("v2")), {
        client: gateway,
        env,
      }),
    ).rejects.toBeInstanceOf(DomainError);

    // 旧文档没有被提前删除，引用仍指向它。
    expect(gateway.documents.map((doc) => doc.id)).toEqual(["doc_1"]);
    expect(gateway.deleted).toHaveLength(0);
    const refs = await store.listByOwner("asset", object.id);
    expect(refs).toHaveLength(1);
    expect(refs[0].documentId).toBe(first.documentId);
  });

  it("旧主文档已在 RAGFlow 侧消失时仍能完成替换", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "旧文档缺失",
      library: "internal",
    });
    const gateway = new FakeGateway();
    const env = { RAGFLOW_DATASET_ID: "ds_main" };
    await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("v1")), {
      client: gateway,
      env,
    });

    // 模拟外部把文档删掉了。
    gateway.documents = [];

    const ref = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("v2")), {
      client: gateway,
      env,
    });

    expect(ref.documentId).toBe("doc_2");
    expect((await store.listByOwner("asset", object.id))[0].documentId).toBe("doc_2");
  });
});

describe("uploadObjectContent RAGFlow 失败", () => {
  it("上传失败时返回可读错误且不落库", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "失败",
      library: "internal",
    });
    const gateway = new FakeGateway();
    gateway.failCreateDocument = new DomainError("INTERNAL", "RAGFlow 请求失败：POST /api/v1/datasets/ds_main/documents");

    const error = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("x")), {
      client: gateway,
      env: { RAGFLOW_DATASET_ID: "ds_main" },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).message).toContain("RAGFlow");
    expect(await store.listByOwner("asset", object.id)).toHaveLength(0);
    expect(await store.listPendingJobs()).toHaveLength(0);
  });

  it("解析触发失败不影响上传，状态停在 pending 等轮询重试", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "解析触发失败",
      library: "internal",
    });
    const gateway = new FakeGateway();
    gateway.failStartParsing = new DomainError("INTERNAL", "RAGFlow chunks 接口失败");

    const ref = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("x")), {
      client: gateway,
      env: { RAGFLOW_DATASET_ID: "ds_main" },
    });

    expect(ref.parseStatus).toBe("pending");
    expect((await store.listByOwner("asset", object.id))[0].parseStatus).toBe("pending");
    expect(await store.listParsing()).toHaveLength(1);
  });

  it("meta 写入失败时删掉刚上传的文档并抛错，不落库", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "meta 失败",
      library: "internal",
    });
    const gateway = new FakeGateway();
    gateway.failMetaUpdate = new DomainError("INTERNAL", "RAGFlow meta 更新失败");

    await expect(
      uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("x")), {
        client: gateway,
        env: { RAGFLOW_DATASET_ID: "ds_main" },
      }),
    ).rejects.toBeInstanceOf(DomainError);

    expect(gateway.deleted).toEqual([{ datasetId: "ds_main", ids: ["doc_1"] }]);
    expect(await store.listByOwner("asset", object.id)).toHaveLength(0);
    expect(await store.listPendingJobs()).toHaveLength(0);
  });
});

describe("dataset 解析（ADR-007 单一 Dataset）", () => {
  it("优先使用 RAGFLOW_DATASET_ID，不再列名查找", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "env id",
      library: "internal",
    });
    const gateway = new FakeGateway();

    const ref = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("x")), {
      client: gateway,
      env: { RAGFLOW_DATASET_ID: "ds_configured", RAGFLOW_DATASET_NAME: "ignored" },
    });

    expect(ref.datasetId).toBe("ds_configured");
    expect(gateway.createDatasetCalls).toHaveLength(0);
  });

  it("未配置时按名称查找，缺失则创建一次并复用", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "按名建库",
      library: "internal",
    });
    const gateway = new FakeGateway();
    const env = {};

    const first = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("x")), {
      client: gateway,
      env,
    });
    const second = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("y")), {
      client: gateway,
      env,
    });

    expect(gateway.createDatasetCalls).toEqual([{ name: DEFAULT_DATASET_NAME }]);
    expect(first.datasetId).toBe("ds_1");
    expect(second.datasetId).toBe("ds_1");
  });

  it("RAGFLOW_DATASET_NAME 可覆盖默认库名", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "自定义库",
      library: "internal",
    });
    const gateway = new FakeGateway();

    const ref = await uploadObjectContent(handle.db, OWNER, object.id, formWith(textFile("x")), {
      client: gateway,
      env: { RAGFLOW_DATASET_NAME: "my-content" },
    });

    expect(gateway.createDatasetCalls).toEqual([{ name: "my-content" }]);
    expect(ref.datasetId).toBe("ds_1");
  });
});

describe("downloadObjectContent", () => {
  class FakeDownloadGateway implements ContentDownloadGateway {
    calls: { datasetId: string; documentId: string }[] = [];

    async downloadDocument(datasetId: string, documentId: string) {
      this.calls.push({ datasetId, documentId });
      return {
        body: null,
        contentType: "text/plain",
        contentLength: 3,
        filename: "note.txt",
      };
    }
  }

  it("按身份与引用归属校验后返回文件流", async () => {
    const object = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "下载",
      library: "internal",
    });
    const ref = await uploadObjectContent(
      handle.db,
      OWNER,
      object.id,
      formWith(textFile("abc")),
      { client: new FakeGateway(), env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );
    const gateway = new FakeDownloadGateway();

    const result = await downloadObjectContent(handle.db, OWNER, object.id, ref.id, {
      client: gateway,
    });

    expect(result.ref.id).toBe(ref.id);
    expect(result.file).toMatchObject({ contentType: "text/plain", filename: "note.txt" });
    expect(gateway.calls).toEqual([{ datasetId: "ds_main", documentId: "doc_1" }]);
  });

  it("他人对象、别的对象的引用都按不存在处理", async () => {
    const mine = await createObject(handle.db, actor(OWNER), {
      type: "asset",
      title: "我的",
      library: "internal",
    });
    const other = await createObject(handle.db, actor(OTHER), {
      type: "asset",
      title: "别人的",
      library: "internal",
    });
    const otherRef = await uploadObjectContent(
      handle.db,
      OTHER,
      other.id,
      formWith(textFile("secret")),
      { client: new FakeGateway(), env: { RAGFLOW_DATASET_ID: "ds_main" } },
    );
    const gateway = new FakeDownloadGateway();

    await expect(
      downloadObjectContent(handle.db, OWNER, mine.id, otherRef.id, { client: gateway }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      downloadObjectContent(handle.db, OWNER, other.id, otherRef.id, { client: gateway }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(gateway.calls).toHaveLength(0);
  });
});
