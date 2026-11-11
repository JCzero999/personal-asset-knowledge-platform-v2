import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";

import type { ContentRef } from "../../domain/content-ref";
import { ConflictError, DomainError, NotFoundError } from "../../domain/errors";
import type { AppDatabase } from "../db/client";
import { ulid } from "../db/id";
import { contentRefs, syncJobs, type ContentRefRow, type NewContentRefRow, type SyncJobRow } from "../db/schema";
import type {
  ContentStore,
  EnqueueJobInput,
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
    const [row] = await this.db
      .insert(syncJobs)
      .values({
        id: ulid(),
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        contentRefId: input.contentRefId ?? null,
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
}
