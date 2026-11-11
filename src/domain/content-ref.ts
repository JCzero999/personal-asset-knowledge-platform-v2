import type { ObjectType } from "./objects";

/**
 * 内容引用（content_ref）：业务对象与 RAGFlow 文档之间的映射。
 *
 * 独立成表而不是 JSON 字段（ADR-007）。`documentId` 是**可变指针**：
 * RAGFlow 更新正文采用「删除 + 重传」，document_id 会变，不能当身份用；
 * 真正的幂等键是 `contentKey`（写入 RAGFlow 的 meta_fields）。
 */

export const contentProviders = ["ragflow"] as const;
export type ContentProvider = (typeof contentProviders)[number];

export const contentRoles = ["primary", "attachment"] as const;
export type ContentRole = (typeof contentRoles)[number];

/** 解析状态：应用侧对 RAGFlow 解析进度的归一化表达。 */
export const parseStatuses = ["pending", "running", "succeeded", "failed"] as const;
export type ParseStatus = (typeof parseStatuses)[number];

/** 同步状态：outbox + 对账使用（ADR-007）。 */
export const syncStates = ["pending", "synced", "sync_failed", "deleted"] as const;
export type SyncState = (typeof syncStates)[number];

export interface ContentRef {
  id: string;
  ownerType: ObjectType;
  ownerId: string;
  provider: ContentProvider;
  datasetId: string;
  /** 可变指针，不是身份。 */
  documentId: string;
  /** 业务自建的幂等键，镜像到 RAGFlow meta_fields。 */
  contentKey: string;
  role: ContentRole;
  documentName: string | null;
  contentHash: string | null;
  mime: string | null;
  sizeBytes: number | null;
  parseStatus: ParseStatus;
  parseError: string | null;
  syncState: SyncState;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export function isContentRole(value: unknown): value is ContentRole {
  return typeof value === "string" && (contentRoles as readonly string[]).includes(value);
}

export function isSyncState(value: unknown): value is SyncState {
  return typeof value === "string" && (syncStates as readonly string[]).includes(value);
}

export function isParseStatus(value: unknown): value is ParseStatus {
  return typeof value === "string" && (parseStatuses as readonly string[]).includes(value);
}
