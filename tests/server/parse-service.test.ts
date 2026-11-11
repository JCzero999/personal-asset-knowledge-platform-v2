import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors";
import type { RagflowDocument } from "../../src/server/adapters/ragflow";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteContentStore } from "../../src/server/repositories/sqlite-content-store";
import {
  pollParsingOnce,
  type ParseGateway,
} from "../../src/server/services/parse-service";

/**
 * 解析轮询测试：RAGFlow 用假网关，数据库用内存 SQLite。
 * 关注状态映射、UNSTART 补触发、分页查找与单点失败不拖垮整轮。
 */

let handle: DatabaseHandle;
let store: SqliteContentStore;

class FakeParseGateway implements ParseGateway {
  documents = new Map<string, RagflowDocument[]>();
  started: { datasetId: string; ids: string[] }[] = [];
  listCalls: { datasetId: string; page: number; pageSize: number }[] = [];
  failList: Error | null = null;
  failStart: Error | null = null;

  async listDocuments(
    datasetId: string,
    query: { page?: number; pageSize?: number } = {},
  ): Promise<{ documents: RagflowDocument[]; total: number }> {
    if (this.failList) throw this.failList;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 100;
    this.listCalls.push({ datasetId, page, pageSize });
    const all = this.documents.get(datasetId) ?? [];
    return {
      documents: all.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
    };
  }

  async startParsing(datasetId: string, documentIds: string | string[]): Promise<void> {
    if (this.failStart) throw this.failStart;
    this.started.push({
      datasetId,
      ids: Array.isArray(documentIds) ? documentIds : [documentIds],
    });
  }
}

function doc(
  id: string,
  run: string,
  progressMessage: string | null = null,
): RagflowDocument {
  return {
    id,
    name: `${id}.txt`,
    datasetId: "ds_1",
    chunkCount: run === "DONE" ? 3 : 0,
    tokenCount: 0,
    chunkMethod: "naive",
    run,
    progressMessage,
  };
}

async function seedRef(documentId: string, parseStatus: "pending" | "running" = "pending") {
  return store.upsert({
    ownerType: "asset",
    ownerId: `owner_${documentId}`,
    datasetId: "ds_1",
    documentId,
    contentKey: `obj:${documentId}:primary`,
    parseStatus,
  });
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
  `);
  store = new SqliteContentStore(handle.db);
});

describe("pollParsingOnce", () => {
  it("RUNNING / DONE / FAIL 映射为 running / succeeded / failed", async () => {
    const running = await seedRef("doc_running", "running");
    const done = await seedRef("doc_done", "running");
    const failed = await seedRef("doc_failed", "running");

    const gateway = new FakeParseGateway();
    gateway.documents.set("ds_1", [
      doc("doc_running", "RUNNING"),
      doc("doc_done", "DONE"),
      doc("doc_failed", "FAIL", "start\nPage(1): parse failed: unsupported file"),
    ]);

    const result = await pollParsingOnce(handle.db, { client: gateway, now: "2026-11-11T00:00:00.000Z" });

    expect(result).toMatchObject({ checked: 3, running: 1, succeeded: 1, failed: 1, started: 0 });
    expect((await store.findById(running.id))?.parseStatus).toBe("running");
    expect((await store.findById(done.id))?.parseStatus).toBe("succeeded");
    expect((await store.findById(failed.id))?.parseStatus).toBe("failed");
    expect((await store.findById(failed.id))?.parseError).toBe(
      "Page(1): parse failed: unsupported file",
    );
  });

  it("UNSTART 时补触发解析，状态保持 pending 等下一轮", async () => {
    const ref = await seedRef("doc_new");

    const gateway = new FakeParseGateway();
    gateway.documents.set("ds_1", [doc("doc_new", "UNSTART")]);

    const result = await pollParsingOnce(handle.db, { client: gateway });

    expect(result.started).toBe(1);
    expect(gateway.started).toEqual([{ datasetId: "ds_1", ids: ["doc_new"] }]);
    expect((await store.findById(ref.id))?.parseStatus).toBe("pending");
  });

  it("触发失败时记录错误且不改变状态", async () => {
    const ref = await seedRef("doc_new");
    const gateway = new FakeParseGateway();
    gateway.documents.set("ds_1", [doc("doc_new", "UNSTART")]);
    gateway.failStart = new DomainError("INTERNAL", "chunks 接口失败");

    const result = await pollParsingOnce(handle.db, { client: gateway });

    expect(result.started).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({ refId: ref.id, message: "chunks 接口失败" }),
    ]);
    expect((await store.findById(ref.id))?.parseStatus).toBe("pending");
  });

  it("文档已不存在时置为 failed", async () => {
    const ref = await seedRef("doc_gone");
    const gateway = new FakeParseGateway();
    gateway.documents.set("ds_1", []);

    const result = await pollParsingOnce(handle.db, { client: gateway });

    expect(result.failed).toBe(1);
    expect((await store.findById(ref.id))?.parseStatus).toBe("failed");
    expect((await store.findById(ref.id))?.parseError).toContain("不存在");
  });

  it("文档在后续分页时仍能找到", async () => {
    await seedRef("doc_1");
    await seedRef("doc_2");
    await seedRef("doc_3");

    const gateway = new FakeParseGateway();
    gateway.documents.set("ds_1", [
      doc("doc_1", "DONE"),
      doc("doc_2", "DONE"),
      doc("doc_3", "DONE"),
    ]);

    const result = await pollParsingOnce(handle.db, {
      client: gateway,
      pageSize: 2,
      maxPages: 10,
    });

    expect(result.succeeded).toBe(3);
    expect(gateway.listCalls.map((call) => call.page)).toEqual([1, 2]);
  });

  it("列表接口失败只影响该 dataset，下一轮可恢复", async () => {
    const ref = await seedRef("doc_1");
    const gateway = new FakeParseGateway();
    gateway.failList = new DomainError("INTERNAL", "RAGFlow 暂时不可用");

    const result = await pollParsingOnce(handle.db, { client: gateway });

    expect(result.checked).toBe(1);
    expect(result.errors[0]).toMatchObject({ refId: ref.id, message: "RAGFlow 暂时不可用" });
    const after = await store.findById(ref.id);
    expect(after?.parseStatus).toBe("pending");
    expect(after?.parseError).toBeNull();
  });

  it("已成功或已删除的引用不再轮询", async () => {
    const done = await seedRef("doc_done");
    await store.updateState(done.id, { parseStatus: "succeeded" });
    const deleted = await seedRef("doc_deleted");
    await store.softDelete(deleted.id);

    const gateway = new FakeParseGateway();
    const result = await pollParsingOnce(handle.db, { client: gateway });

    expect(result.checked).toBe(0);
    expect(gateway.listCalls).toHaveLength(0);
  });
});
