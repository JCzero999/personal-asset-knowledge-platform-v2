import type {
  ContentRef,
  ContentRole,
  ParseStatus,
  SyncState,
} from "../../domain/content-ref";
import type { ObjectType } from "../../domain/objects";

/**
 * 内容引用存储端口。
 *
 * 只负责业务侧的映射与 outbox 落库；真正调用 RAGFlow 的代码属于
 * `server/adapters/ragflow`（本轮为占位目录）。
 */

export interface UpsertContentRefInput {
  id?: string;
  ownerType: ObjectType;
  ownerId: string;
  datasetId: string;
  documentId: string;
  contentKey: string;
  role?: ContentRole;
  documentName?: string | null;
  contentHash?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
  parseStatus?: ParseStatus;
  parseError?: string | null;
  syncState?: SyncState;
  lastSyncedAt?: string | null;
  now?: string;
}

export interface SyncJob {
  id: string;
  ownerType: ObjectType;
  ownerId: string;
  contentRefId: string | null;
  action: "upsert" | "delete";
  state: "pending" | "running" | "done" | "failed";
  attempts: number;
  lastError: string | null;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput {
  ownerType: ObjectType;
  ownerId: string;
  contentRefId?: string | null;
  action: "upsert" | "delete";
  availableAt?: string;
  now?: string;
}

export interface ContentStore {
  upsert(input: UpsertContentRefInput): Promise<ContentRef>;

  findById(id: string): Promise<ContentRef | null>;

  listByOwner(ownerType: ObjectType, ownerId: string): Promise<ContentRef[]>;

  findPrimary(ownerType: ObjectType, ownerId: string): Promise<ContentRef | null>;

  /** 解析/同步状态回写；`documentId` 可在重传后更新（可变指针）。 */
  updateState(
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
  ): Promise<ContentRef>;

  softDelete(id: string, at?: string): Promise<void>;

  enqueueJob(input: EnqueueJobInput): Promise<SyncJob>;

  listPendingJobs(limit?: number): Promise<SyncJob[]>;
}
