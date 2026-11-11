import { NotFoundError } from "../../domain/errors";
import type { ContentRef } from "../../domain/content-ref";
import {
  createRagflowClientFromEnv,
  type DocumentMetaFields,
} from "../adapters/ragflow";
import type { AppDatabase } from "../db/client";
import type { SyncJob } from "../ports/content-store";
import { SqliteContentStore } from "../repositories/sqlite-content-store";
import { SqliteObjectRepository } from "../repositories/sqlite-object-repository";
import { buildMetaFields } from "./content-service";

/**
 * outbox 消费端：把对象写事务里入队的 `sync_jobs` 投递到 RAGFlow。
 *
 * 只做对账语义，不做业务校验：
 * - `upsert`：按 `content_key` 认回文档，整体重写 `meta_fields`（库别、归档等）；
 * - `delete`：删掉该对象在 RAGFlow 的所有文档，再把本地引用软删除；
 * - 文档在 RAGFlow 已不存在视为「已达到目标状态」，不重试；
 * - 其它失败交给 `markJobFailed` 的指数退避，达到上限置 `failed` 等人看。
 *
 * 任务本身没有 `ownerSub`：单用户阶段按对象归属过滤没有意义，worker 以系统身份运行。
 */

/** 只依赖这两个动作，测试可注入假实现；`RagflowClient` 结构上满足。 */
export interface SyncGateway {
  updateDocumentMetaFields(
    datasetId: string,
    documentId: string,
    metaFields: DocumentMetaFields,
  ): Promise<void>;
  deleteDocument(datasetId: string, documentIds: string | string[]): Promise<void>;
}

export interface RunSyncOptions {
  client?: SyncGateway;
  env?: Record<string, string | undefined>;
  /** 单次最多认领多少条，默认 10。 */
  limit?: number;
  /** `running` 超过该时长视为租约过期，可被重新认领，默认 5 分钟。 */
  staleAfterMs?: number;
  now?: string;
}

export interface SyncRunResult {
  claimed: number;
  done: number;
  failed: number;
  errors: Array<{
    jobId: string;
    ownerType: SyncJob["ownerType"];
    ownerId: string;
    action: SyncJob["action"];
    message: string;
  }>;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_LEASE_MS = 5 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 任务指向的内容引用：指定了 `contentRefId` 就只处理那一条，否则处理该对象全部有效引用。 */
async function refsForJob(
  store: SqliteContentStore,
  job: SyncJob,
): Promise<ContentRef[]> {
  if (job.contentRefId) {
    const ref = await store.findById(job.contentRefId);
    return ref ? [ref] : [];
  }

  return store.listByOwner(job.ownerType, job.ownerId);
}

async function applyUpsert(
  job: SyncJob,
  store: SqliteContentStore,
  objects: SqliteObjectRepository,
  client: SyncGateway,
  now: string,
): Promise<void> {
  const object = await objects.findById(job.ownerId);
  // 对象已删除时，删除路径由同一对象的 delete 任务负责；这条 upsert 没有可镜像的目标。
  if (!object || object.deletedAt) {
    return;
  }

  const refs = await refsForJob(store, job);
  const failures: unknown[] = [];

  for (const ref of refs) {
    try {
      await client.updateDocumentMetaFields(
        ref.datasetId,
        ref.documentId,
        buildMetaFields(object, ref.contentKey),
      );
      await store.updateState(ref.id, {
        syncState: "synced",
        lastSyncedAt: now,
        now,
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        // 文档已被删掉（旧文档清理或人工操作）：保留引用但标记为不可同步，
        // 不重试——重传正文会生成新的 document_id 并把状态带回 synced。
        await store.updateState(ref.id, { syncState: "sync_failed", now }).catch(() => undefined);
        continue;
      }
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw failures[0];
  }
}

async function applyDelete(
  job: SyncJob,
  store: SqliteContentStore,
  client: SyncGateway,
  now: string,
): Promise<void> {
  const refs = await refsForJob(store, job);
  const failures: unknown[] = [];

  for (const ref of refs) {
    try {
      await client.deleteDocument(ref.datasetId, ref.documentId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        failures.push(error);
        continue;
      }
    }

    try {
      await store.softDelete(ref.id, now);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        failures.push(error);
      }
    }
  }

  if (failures.length > 0) {
    throw failures[0];
  }
}

/** 认领并处理一批到期任务；单条任务失败只影响它自己。 */
export async function runSyncOnce(
  db: AppDatabase,
  options: RunSyncOptions = {},
): Promise<SyncRunResult> {
  const env = options.env ?? process.env;
  const store = new SqliteContentStore(db);
  const objects = new SqliteObjectRepository(db);
  const client = options.client ?? createRagflowClientFromEnv(env);
  const now = options.now ?? new Date().toISOString();

  const jobs = await store.claimJobs({
    limit: options.limit ?? DEFAULT_LIMIT,
    staleAfterMs: options.staleAfterMs ?? DEFAULT_LEASE_MS,
    now,
  });

  const result: SyncRunResult = {
    claimed: jobs.length,
    done: 0,
    failed: 0,
    errors: [],
  };

  for (const job of jobs) {
    try {
      if (job.action === "upsert") {
        await applyUpsert(job, store, objects, client, now);
      } else {
        await applyDelete(job, store, client, now);
      }
      await store.markJobDone(job.id, now);
      result.done += 1;
    } catch (error) {
      const message = errorText(error);
      await store.markJobFailed({ id: job.id, error: message, now }).catch(() => undefined);
      result.failed += 1;
      result.errors.push({
        jobId: job.id,
        ownerType: job.ownerType,
        ownerId: job.ownerId,
        action: job.action,
        message,
      });
    }
  }

  return result;
}
