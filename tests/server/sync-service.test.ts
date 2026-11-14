import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError, NotFoundError } from "../../src/domain/errors";
import type { DocumentMetaFields } from "../../src/server/adapters/ragflow";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteContentStore } from "../../src/server/repositories/sqlite-content-store";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import { seedTag } from "../helpers/seed";
import {
  runSyncOnce,
  type SyncGateway,
} from "../../src/server/services/sync-service";

/**
 * outbox 消费端测试：Redis/外部服务全部用假网关，数据库用内存 SQLite。
 * 覆盖投递语义（镜像字段、删除、404 视为已达目标、失败退避）与任务状态流转。
 */

const OWNER = "user_1";
const NOW = "2026-11-11T08:00:00.000Z";

let handle: DatabaseHandle;
let objects: SqliteObjectRepository;
let store: SqliteContentStore;

class FakeGateway implements SyncGateway {
  metaCalls: { datasetId: string; documentId: string; meta: DocumentMetaFields }[] = [];
  deleted: { datasetId: string; ids: string[] }[] = [];
  missingDocuments = new Set<string>();
  failWith: Error | null = null;

  async updateDocumentMetaFields(
    datasetId: string,
    documentId: string,
    metaFields: DocumentMetaFields,
  ): Promise<void> {
    if (this.failWith) throw this.failWith;
    if (this.missingDocuments.has(documentId)) {
      throw new NotFoundError(`Document ${documentId} not found`);
    }
    this.metaCalls.push({ datasetId, documentId, meta: metaFields });
  }

  async deleteDocument(datasetId: string, documentIds: string | string[]): Promise<void> {
    if (this.failWith) throw this.failWith;
    const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
    const missing = ids.filter((id) => this.missingDocuments.has(id));
    if (missing.length > 0) {
      throw new NotFoundError(`Documents not found: ${missing.join(",")}`);
    }
    this.deleted.push({ datasetId, ids });
  }
}

async function seedWork() {
  const work = await objects.create({
    type: "work",
    title: "如何做一门课",
    // 作品只存在于外库（ADR-029）；同步链路与库别无关。
    library: "external",
    category: "article",
    ownerSub: OWNER,
    tags: ["教学"],
  });

  const ref = await store.upsert({
    ownerType: "work",
    ownerId: work.id,
    datasetId: "ds_1",
    documentId: "doc_1",
    contentKey: `obj:${work.id}:primary`,
    role: "primary",
    documentName: "note.txt",
    mime: "text/plain",
    sizeBytes: 12,
    parseStatus: "pending",
    syncState: "pending",
  });

  return { work, ref };
}

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
  // ADR-023：标签只能选词表已有项。
  seedTag(handle, "教学");
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  // 入队时写入的是系统时钟，认领用的是测试里的 NOW；固定系统时间，
  // 否则真实时间越过 NOW 后任务会变成「尚未到期」，测试随时间失效。
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  handle.sqlite.exec(`
    DELETE FROM sync_jobs;
    DELETE FROM content_refs;
    DELETE FROM library_events;
    DELETE FROM objects;
  `);
  objects = new SqliteObjectRepository(handle.db);
  store = new SqliteContentStore(handle.db);
});

describe("runSyncOnce / upsert", () => {
  it("把最新的库别、归档状态写进 meta_fields，并把引用标记为已同步", async () => {
    const { work, ref } = await seedWork();

    // 作品只存在于外库（ADR-029），不能跨库迁移；归档同样在写事务里入队，
    // 与创建时的 upsert 合并成一条，meta_fields 仍按最新状态渲染。
    await objects.archive(work.id);

    const gateway = new FakeGateway();
    const result = await runSyncOnce(handle.db, { client: gateway, now: NOW });

    expect(result.claimed).toBe(1);
    expect(result.done).toBe(1);
    expect(result.failed).toBe(0);

    expect(gateway.metaCalls).toHaveLength(1);
    const [call] = gateway.metaCalls;
    expect(call.datasetId).toBe("ds_1");
    expect(call.documentId).toBe("doc_1");
    expect(call.meta).toMatchObject({
      content_key: `obj:${work.id}:primary`,
      owner_type: "work",
      owner_id: work.id,
      library: "external",
      archived: "true",
      format: "article",
    });
    expect(call.meta).not.toHaveProperty("status");

    const synced = await store.findById(ref.id);
    expect(synced?.syncState).toBe("synced");
    expect(synced?.lastSyncedAt).toBe(NOW);

    const job = (await store.listPendingJobs(10, "2030-01-01T00:00:00.000Z"))[0];
    expect(job).toBeUndefined();
  });

  it("文档在 RAGFlow 已不存在：标记 sync_failed，任务仍算完成，不无限重试", async () => {
    const { work, ref } = await seedWork();
    await store.enqueueJob({
      ownerType: "work",
      ownerId: work.id,
      contentRefId: ref.id,
      action: "upsert",
    });

    const gateway = new FakeGateway();
    gateway.missingDocuments.add("doc_1");

    const result = await runSyncOnce(handle.db, { client: gateway, now: NOW });

    expect(result.done).toBe(1);
    expect(result.failed).toBe(0);
    expect(gateway.metaCalls).toHaveLength(0);

    const stale = await store.findById(ref.id);
    expect(stale?.syncState).toBe("sync_failed");
  });

  it("RAGFlow 调用失败：任务回到 pending 并记录错误，等退避重试", async () => {
    const { work, ref } = await seedWork();
    await store.enqueueJob({
      ownerType: "work",
      ownerId: work.id,
      contentRefId: ref.id,
      action: "upsert",
    });

    const gateway = new FakeGateway();
    gateway.failWith = new DomainError("INTERNAL", "RAGFlow 请求失败", { cause: "ECONNREFUSED" });

    const result = await runSyncOnce(handle.db, { client: gateway, now: NOW });

    expect(result.done).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].message).toContain("RAGFlow 请求失败");

    const retryable = await store.listPendingJobs(10, "2030-01-01T00:00:00.000Z");
    expect(retryable).toHaveLength(1);
    expect(retryable[0].attempts).toBe(1);
    expect(retryable[0].lastError).toContain("RAGFlow 请求失败");

    const untouched = await store.findById(ref.id);
    expect(untouched?.syncState).toBe("pending");
  });

  it("对象还没有内容引用：任务直接完成，不调用 RAGFlow", async () => {
    const work = await objects.create({
      type: "asset",
      title: "没有正文的资产",
      library: "internal",
      ownerSub: OWNER,
    });
    await store.enqueueJob({
      ownerType: "asset",
      ownerId: work.id,
      action: "upsert",
    });

    const gateway = new FakeGateway();
    const result = await runSyncOnce(handle.db, { client: gateway, now: NOW });

    expect(result.done).toBe(1);
    expect(gateway.metaCalls).toHaveLength(0);
  });

  it("对象已被软删除：upsert 没有镜像目标，直接完成", async () => {
    const { work, ref } = await seedWork();
    await store.enqueueJob({
      ownerType: "work",
      ownerId: work.id,
      contentRefId: ref.id,
      action: "upsert",
    });
    // 只软删对象，不经过仓储的 delete 入队，模拟「只有 upsert 残留」的场景。
    handle.sqlite.prepare("UPDATE objects SET deleted_at = ? WHERE id = ?").run(NOW, work.id);

    const gateway = new FakeGateway();
    const result = await runSyncOnce(handle.db, { client: gateway, now: NOW });

    expect(result.done).toBe(1);
    expect(gateway.metaCalls).toHaveLength(0);
  });
});

describe("runSyncOnce / delete", () => {
  it("删掉 RAGFlow 文档后软删引用，任务完成", async () => {
    const { work, ref } = await seedWork();
    await objects.softDelete(work.id);

    const gateway = new FakeGateway();
    const result = await runSyncOnce(handle.db, { client: gateway, now: NOW });

    expect(result.done).toBe(1);
    expect(gateway.deleted).toEqual([{ datasetId: "ds_1", ids: ["doc_1"] }]);
    expect(await store.findById(ref.id)).toBeNull();
  });

  it("文档已不存在也视为删除成功，本地引用照样软删", async () => {
    const { work, ref } = await seedWork();
    await objects.softDelete(work.id);

    const gateway = new FakeGateway();
    gateway.missingDocuments.add("doc_1");

    const result = await runSyncOnce(handle.db, { client: gateway, now: NOW });

    expect(result.done).toBe(1);
    expect(await store.findById(ref.id)).toBeNull();
  });

  it("RAGFlow 删除失败时保留引用并重试", async () => {
    const { work, ref } = await seedWork();
    await objects.softDelete(work.id);

    const gateway = new FakeGateway();
    gateway.failWith = new DomainError("INTERNAL", "网络异常");

    const result = await runSyncOnce(handle.db, { client: gateway, now: NOW });

    expect(result.failed).toBe(1);
    expect(await store.findById(ref.id)).not.toBeNull();
  });
});
