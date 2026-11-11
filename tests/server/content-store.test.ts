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

  it("相同 owner + action 已有活跃任务时不重复入队", async () => {
    const first = await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "upsert",
    });
    const second = await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "upsert",
    });

    expect(second.id).toBe(first.id);

    const otherAction = await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "delete",
    });
    expect(otherAction.id).not.toBe(first.id);
    expect(await store.listPendingJobs()).toHaveLength(2);
  });

  it("任务完成后可以再次入队", async () => {
    const first = await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "upsert",
    });
    await store.markJobDone(first.id);

    const second = await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "upsert",
    });

    expect(second.id).not.toBe(first.id);
    expect(second.state).toBe("pending");
  });

  it("认领后置为 running、attempts 加一，且不会重复认领", async () => {
    const job = await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "upsert",
      now: "2026-11-11T06:00:00.000Z",
    });

    const claimed = await store.claimJobs({ now: "2026-11-11T06:00:00.000Z" });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: job.id, state: "running", attempts: 1 });
    expect(await store.claimJobs({ now: "2026-11-11T06:00:00.000Z" })).toEqual([]);
  });

  it("租约过期的 running 任务可被重新认领", async () => {
    const job = await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "upsert",
      now: "2026-11-11T06:00:00.000Z",
    });
    await store.claimJobs({ now: "2026-11-11T06:00:00.000Z" });

    // 未开启租约回收时看不到它
    expect(await store.claimJobs({ now: "2026-11-11T06:30:00.000Z" })).toEqual([]);

    const reclaimed = await store.claimJobs({
      now: "2026-11-11T06:30:00.000Z",
      staleAfterMs: 10 * 60_000,
    });

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ id: job.id, state: "running", attempts: 2 });
  });

  it("失败后按退避重试，达到上限置为 failed", async () => {
    const job = await store.enqueueJob({
      ownerType: "work",
      ownerId: baseRef.ownerId,
      action: "upsert",
      now: "2026-11-11T06:00:00.000Z",
    });

    await store.claimJobs({ now: "2026-11-11T06:00:00.000Z" });
    const retried = await store.markJobFailed({
      id: job.id,
      error: "RAGFlow 502",
      now: "2026-11-11T06:00:00.000Z",
    });

    expect(retried).toMatchObject({ state: "pending", lastError: "RAGFlow 502" });
    expect(retried.availableAt).toBe("2026-11-11T06:01:00.000Z");

    await store.claimJobs({ now: "2026-11-11T06:02:00.000Z" });
    const failed = await store.markJobFailed({
      id: job.id,
      error: "RAGFlow 502",
      maxAttempts: 2,
      now: "2026-11-11T06:02:00.000Z",
    });

    expect(failed).toMatchObject({ state: "failed", lastError: "RAGFlow 502" });
    expect(await store.claimJobs({ now: "2026-11-11T07:00:00.000Z" })).toEqual([]);
  });

  it("标记不存在或已完成的任务时如实报错", async () => {
    await expect(store.markJobDone("01HZZZZZZZZZZZZZZZZZZZZZZZ")).rejects.toThrow();
  });
});
