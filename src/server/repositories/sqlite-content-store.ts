import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { ContentRef } from "../../domain/content-ref";
import { ConflictError, DomainError, NotFoundError } from "../../domain/errors";
import type { AppDatabase } from "../db/client";
import { ulid } from "../db/id";
import { contentRefs, syncJobs, type ContentRefRow, type NewContentRefRow, type SyncJobRow } from "../db/schema";
import type {
  ClaimJobsInput,
  ContentStore,
  EnqueueJobInput,
  FailJobInput,
  SyncJob,
  UpsertContentRefInput,
} from "../ports/content-store";

/**
 * `ContentStore` 的 SQLite 实现。
 *
 * upsert 以 (dataset_id, content_key) 为幂等键：document_id 会在重传后变化，
 * 不能拿它认领旧记录。若新的 document_id 撞上别的记录，交给唯一约束报冲突。
 */

function nowIso(): string {
  return new Date().toISOString();
}

/** 指数退避：第 1 次失败等 1 分钟，逐次翻倍，最长 30 分钟。 */
function backoffAfter(now: string, attempts: number): string {
  const minutes = Math.min(2 ** Math.max(attempts - 1, 0), 30);
  return new Date(Date.parse(now) + minutes * 60_000).toISOString();
}

function isoBefore(now: string, ms: number): string {
  return new Date(Date.parse(now) - ms).toISOString();
}

function toContentRef(row: ContentRefRow): ContentRef {
  return {
    id: row.id,
    ownerType: row.ownerType as ContentRef["ownerType"],
    ownerId: row.ownerId,
    provider: row.provider as ContentRef["provider"],
    datasetId: row.datasetId,
    documentId: row.documentId,
    contentKey: row.contentKey,
    role: row.role as ContentRef["role"],
    documentName: row.documentName,
    contentHash: row.contentHash,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    parseStatus: row.parseStatus as ContentRef["parseStatus"],
    parseError: row.parseError,
    syncState: row.syncState as ContentRef["syncState"],
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toSyncJob(row: SyncJobRow): SyncJob {
  return {
    id: row.id,
    ownerType: row.ownerType as SyncJob["ownerType"],
    ownerId: row.ownerId,
    contentRefId: row.contentRefId,
    action: row.action as SyncJob["action"],
    state: row.state as SyncJob["state"],
    attempts: row.attempts,
    lastError: row.lastError,
    availableAt: row.availableAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translate(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (/UNIQUE constraint failed/i.test(message)) {
    throw new ConflictError(`内容引用唯一约束冲突：${message}`, { detail: message });
  }

  if (/CHECK constraint failed/i.test(message)) {
    throw new DomainError("CONSTRAINT_VIOLATION", `数据库约束拒绝写入：${message}`, {
      detail: message,
    });
  }

  throw error;
}

export class SqliteContentStore implements ContentStore {
  constructor(private readonly db: AppDatabase) {}

  async upsert(input: UpsertContentRefInput): Promise<ContentRef> {
    const now = input.now ?? nowIso();
    const [existing] = await this.db
      .select()
      .from(contentRefs)
      .where(
        and(
          eq(contentRefs.datasetId, input.datasetId),
          eq(contentRefs.contentKey, input.contentKey),
        ),
      )
      .limit(1);

    if (existing) {
      // document_id 会变：以 content_key 认回记录后更新指针与元数据。
      const patch: Partial<NewContentRefRow> = {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        documentId: input.documentId,
        role: input.role ?? existing.role,
        documentName: input.documentName ?? existing.documentName,
        contentHash: input.contentHash ?? existing.contentHash,
        mime: input.mime ?? existing.mime,
        sizeBytes: input.sizeBytes ?? existing.sizeBytes,
        parseStatus: input.parseStatus ?? existing.parseStatus,
        parseError: input.parseError ?? existing.parseError,
        syncState: input.syncState ?? existing.syncState,
        lastSyncedAt: input.lastSyncedAt ?? existing.lastSyncedAt,
        updatedAt: now,
        deletedAt: null,
      };

      try {
        const [row] = await this.db
          .update(contentRefs)
          .set(patch)
          .where(eq(contentRefs.id, existing.id))
          .returning();
        return toContentRef(row);
      } catch (error) {
        return translate(error);
      }
    }

    const row: NewContentRefRow = {
      id: input.id ?? ulid(),
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      provider: "ragflow",
      datasetId: input.datasetId,
      documentId: input.documentId,
      contentKey: input.contentKey,
      role: input.role ?? "primary",
      documentName: input.documentName ?? null,
      contentHash: input.contentHash ?? null,
      mime: input.mime ?? null,
      sizeBytes: input.sizeBytes ?? null,
      parseStatus: input.parseStatus ?? "pending",
      parseError: input.parseError ?? null,
      syncState: input.syncState ?? "pending",
      lastSyncedAt: input.lastSyncedAt ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    try {
      const [created] = await this.db.insert(contentRefs).values(row).returning();
      return toContentRef(created);
    } catch (error) {
      return translate(error);
    }
  }

  async findById(id: string): Promise<ContentRef | null> {
    const [row] = await this.db
      .select()
      .from(contentRefs)
      .where(and(eq(contentRefs.id, id), isNull(contentRefs.deletedAt)))
      .limit(1);

    return row ? toContentRef(row) : null;
  }

  async listByOwner(
    ownerType: ContentRef["ownerType"],
    ownerId: string,
  ): Promise<ContentRef[]> {
    const rows = await this.db
      .select()
      .from(contentRefs)
      .where(
        and(
          eq(contentRefs.ownerType, ownerType),
          eq(contentRefs.ownerId, ownerId),
          isNull(contentRefs.deletedAt),
        ),
      )
      .orderBy(asc(contentRefs.createdAt));

    return rows.map(toContentRef);
  }

  async findPrimary(
    ownerType: ContentRef["ownerType"],
    ownerId: string,
  ): Promise<ContentRef | null> {
    const [row] = await this.db
      .select()
      .from(contentRefs)
      .where(
        and(
          eq(contentRefs.ownerType, ownerType),
          eq(contentRefs.ownerId, ownerId),
          eq(contentRefs.role, "primary"),
          isNull(contentRefs.deletedAt),
        ),
      )
      .limit(1);

    return row ? toContentRef(row) : null;
  }

  async updateState(
    id: string,
    patch: Partial<
      Pick<
        ContentRef,
        | "documentId"
        | "parseStatus"
        | "parseError"
        | "syncState"
        | "lastSyncedAt"
        | "sizeBytes"
        | "contentHash"
      >
    > & { now?: string },
  ): Promise<ContentRef> {
    const { now = nowIso(), ...fields } = patch;

    if (Object.keys(fields).length === 0) {
      throw new DomainError("VALIDATION_FAILED", "updateState 至少需要一个字段");
    }

    try {
      const [row] = await this.db
        .update(contentRefs)
        .set({ ...fields, updatedAt: now })
        .where(and(eq(contentRefs.id, id), isNull(contentRefs.deletedAt)))
        .returning();

      if (!row) {
        throw new NotFoundError("内容引用不存在或已删除", { id });
      }

      return toContentRef(row);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      return translate(error);
    }
  }

  async softDelete(id: string, at: string = nowIso()): Promise<void> {
    const [row] = await this.db
      .update(contentRefs)
      .set({ deletedAt: at, updatedAt: at, syncState: "deleted" })
      .where(and(eq(contentRefs.id, id), isNull(contentRefs.deletedAt)))
      .returning({ id: contentRefs.id });

    if (!row) {
      throw new NotFoundError("内容引用不存在或已删除", { id });
    }
  }

  async enqueueJob(input: EnqueueJobInput): Promise<SyncJob> {
    const now = input.now ?? nowIso();
    const contentRefId = input.contentRefId ?? null;

    const findActive = async (): Promise<SyncJob | null> => {
      const [row] = await this.db
        .select()
        .from(syncJobs)
        .where(
          and(
            eq(syncJobs.ownerType, input.ownerType),
            eq(syncJobs.ownerId, input.ownerId),
            contentRefId === null
              ? isNull(syncJobs.contentRefId)
              : eq(syncJobs.contentRefId, contentRefId),
            eq(syncJobs.action, input.action),
            inArray(syncJobs.state, ["pending", "running"]),
          ),
        )
        .limit(1);

      return row ? toSyncJob(row) : null;
    };

    const active = await findActive();
    if (active) {
      return active;
    }

    try {
      const [row] = await this.db
        .insert(syncJobs)
        .values({
          id: ulid(),
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          contentRefId,
          action: input.action,
          state: "pending",
          attempts: 0,
          lastError: null,
          availableAt: input.availableAt ?? now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return toSyncJob(row);
    } catch (error) {
      // 并发入队撞上活跃任务唯一索引：返回已有任务，不算失败。
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed/i.test(message)) {
        const existing = await findActive();
        if (existing) {
          return existing;
        }
      }

      return translate(error);
    }
  }

  async listPendingJobs(limit = 50, at: string = nowIso()): Promise<SyncJob[]> {
    const rows = await this.db
      .select()
      .from(syncJobs)
      .where(and(eq(syncJobs.state, "pending"), lte(syncJobs.availableAt, at)))
      .orderBy(asc(syncJobs.availableAt), desc(syncJobs.createdAt))
      .limit(limit);

    return rows.map(toSyncJob);
  }

  async claimJobs(input: ClaimJobsInput = {}): Promise<SyncJob[]> {
    const now = input.now ?? nowIso();
    const limit = input.limit ?? 10;

    if (!Number.isInteger(limit) || limit < 1) {
      throw new DomainError("VALIDATION_FAILED", "limit 必须是正整数", { limit });
    }

    const claimable = input.staleAfterMs
      ? or(
          and(eq(syncJobs.state, "pending"), lte(syncJobs.availableAt, now)),
          and(
            eq(syncJobs.state, "running"),
            lte(syncJobs.updatedAt, isoBefore(now, input.staleAfterMs)),
          ),
        )
      : and(eq(syncJobs.state, "pending"), lte(syncJobs.availableAt, now));

    const dueIds = this.db
      .select({ id: syncJobs.id })
      .from(syncJobs)
      .where(claimable)
      .orderBy(asc(syncJobs.availableAt), asc(syncJobs.createdAt))
      .limit(limit);

    // 单条 UPDATE ... WHERE id IN (SELECT ...) 保证认领原子性：两个 worker 不会拿到同一条。
    const rows = await this.db
      .update(syncJobs)
      .set({
        state: "running",
        attempts: sql`${syncJobs.attempts} + 1`,
        updatedAt: now,
      })
      .where(inArray(syncJobs.id, dueIds))
      .returning();

    return rows.map(toSyncJob);
  }

  async markJobDone(id: string, now: string = nowIso()): Promise<SyncJob> {
    const [row] = await this.db
      .update(syncJobs)
      .set({ state: "done", lastError: null, updatedAt: now })
      .where(eq(syncJobs.id, id))
      .returning();

    if (!row) {
      throw new NotFoundError("同步任务不存在", { id });
    }

    return toSyncJob(row);
  }

  async markJobFailed(input: FailJobInput): Promise<SyncJob> {
    const now = input.now ?? nowIso();
    const [current] = await this.db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.id, input.id))
      .limit(1);

    if (!current) {
      throw new NotFoundError("同步任务不存在", { id: input.id });
    }

    const maxAttempts = input.maxAttempts ?? 5;
    const exhausted = current.attempts >= maxAttempts;
    const retryAt = exhausted
      ? current.availableAt
      : (input.retryAt ?? backoffAfter(now, current.attempts));

    const [row] = await this.db
      .update(syncJobs)
      .set({
        state: exhausted ? "failed" : "pending",
        lastError: input.error,
        availableAt: retryAt,
        updatedAt: now,
      })
      .where(eq(syncJobs.id, input.id))
      .returning();

    return toSyncJob(row);
  }
}
