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

export interface ClaimJobsInput {
  limit?: number;
  now?: string;
  /**
   * 租约：`running` 且超过该时长未更新的任务视为认领者已退出，可被重新认领。
   * 不传则只认领 `pending` 任务。
   */
  staleAfterMs?: number;
}

export interface FailJobInput {
  id: string;
  error: string;
  /** 下次可执行时间；不传按已尝试次数做指数退避。 */
  retryAt?: string;
  /** 达到该次数直接置为 failed，默认 5。 */
  maxAttempts?: number;
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

  /** 同一 owner + action 已有活跃任务时直接返回它，不重复入队。 */
  enqueueJob(input: EnqueueJobInput): Promise<SyncJob>;

  /** 只读查看待执行任务；真正交给 worker 的入口是 claimJobs。 */
  listPendingJobs(limit?: number, at?: string): Promise<SyncJob[]>;

  /**
   * 原子认领：把到期任务置为 `running` 并 `attempts + 1`，返回本次认领到的任务。
   * 多个 worker 同时调用不会拿到同一条。
   */
  claimJobs(input?: ClaimJobsInput): Promise<SyncJob[]>;

  markJobDone(id: string, now?: string): Promise<SyncJob>;

  /**
   * 记录失败：未达上限则回到 `pending` 并按退避安排下次执行，
   * 达到上限则置为 `failed`。
   */
  markJobFailed(input: FailJobInput): Promise<SyncJob>;
}
