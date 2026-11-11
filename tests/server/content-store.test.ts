import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteContentStore } from "../../src/server/repositories/sqlite-content-store";

const baseRef = {
  ownerType: "work" as const,
  ownerId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  datasetId: "ds_ragflow_1",
  documentId: "doc_a",
  contentKey: "work:01HZZZZZZZZZZZZZZZZZZZZZZZ:primary",
};

let handle: DatabaseHandle;
let store: SqliteContentStore;

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec("DELETE FROM content_refs; DELETE FROM sync_jobs;");
  store = new SqliteContentStore(handle.db);
});

describe("content refs", () => {
  it("以 content_key 认回记录：重传换 document_id 时更新同一行", async () => {
    const first = await store.upsert(baseRef);
    expect(first.provider).toBe("ragflow");
    expect(first.role).toBe("primary");
    expect(first.documentId).toBe("doc_a");

    const second = await store.upsert({ ...baseRef, documentId: "doc_b_reuploaded" });

    expect(second.id).toBe(first.id);
    expect(second.documentId).toBe("doc_b_reuploaded");

    const all = await store.listByOwner(baseRef.ownerType, baseRef.ownerId);
    expect(all).toHaveLength(1);
  });

  it("同一 owner 只能有一个有效 primary 引用", async () => {
    await store.upsert(baseRef);

    await expect(
      store.upsert({ ...baseRef, documentId: "doc_other", contentKey: "another-key" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("同一 dataset 内 document_id 不可重复", async () => {
    await store.upsert(baseRef);

    await expect(
      store.upsert({
        ...baseRef,
        ownerId: "01HYYYYYYYYYYYYYYYYYYYYYYY",
        contentKey: "work:01HYYYYYYYYYYYYYYYYYYYYYYY:primary",
        role: "attachment",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("软删除后主引用唯一约束释放", async () => {
    const ref = await store.upsert(baseRef);
    await store.softDelete(ref.id);

    expect(await store.findPrimary(baseRef.ownerType, baseRef.ownerId)).toBeNull();

    const replacement = await store.upsert({
      ...baseRef,
      documentId: "doc_new",
      contentKey: "work:01HZZZZZZZZZZZZZZZZZZZZZZZ:primary:v2",
    });

    expect(replacement.id).not.toBe(ref.id);
  });

  it("状态回写", async () => {
    const ref = await store.upsert(baseRef);
    const parsed = await store.updateState(ref.id, {
      parseStatus: "succeeded",
      syncState: "synced",
      lastSyncedAt: "2026-11-11T05:00:00.000Z",
    });

    expect(parsed.parseStatus).toBe("succeeded");
    expect(parsed.syncState).toBe("synced");
  });
});

describe("sync jobs (outbox)", () => {
  it("入队后可被 worker 拉取", async () => {
    const job = await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "upsert",
    });

    expect(job.state).toBe("pending");

    const pending = await store.listPendingJobs();
    expect(pending.map((item) => item.id)).toEqual([job.id]);
  });

  it("未来才可用的任务不会被提前取走", async () => {
    await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "upsert",
      availableAt: "2999-01-01T00:00:00.000Z",
    });

    expect(await store.listPendingJobs(50, "2026-11-11T00:00:00.000Z")).toEqual([]);
  });
});
