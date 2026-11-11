import type {
  BusinessObject,
  Library,
  ObjectOrigin,
  ObjectSource,
  ObjectType,
  Priority,
  WorkFormat,
  WorkStatus,
} from "../../domain/objects";

/**
 * 业务对象仓储端口。
 *
 * 接口职责是「持久化 + 最小一致性」，不在这里做权限、内容同步或外部调用；
 * 需要那些能力的实现留在 `server/services`（本轮只有占位）。
 */

export interface CreateObjectInput {
  /** 不传则由实现生成 ULID。 */
  id?: string;
  type: ObjectType;
  title: string;
  description?: string | null;
  library: Library;
  source?: ObjectSource;
  origin?: ObjectOrigin;
  /** 第一个元素同时写为主分类。 */
  categories?: string[];
  tags?: string[];
  priority?: Priority;
  ownerSub: string;
  // ---- 仅 work ----
  format?: WorkFormat;
  status?: WorkStatus;
  sourceNote?: string | null;
  /** 由实现注入统一时钟；主要在测试中使用。 */
  now?: string;
}

export interface UpdateObjectInput {
  title?: string;
  description?: string | null;
  source?: ObjectSource;
  origin?: ObjectOrigin;
  categories?: string[];
  tags?: string[];
  priority?: Priority;
  format?: WorkFormat;
  sourceNote?: string | null;
  /** 乐观锁：必须与库中 revision 一致，否则抛 ConflictError。 */
  expectedRevision: number;
  now?: string;
}

export interface ListObjectsQuery {
  /** 只返回该用户的对象；单用户阶段由调用方固定传入当前会话的 sub。 */
  ownerSub?: string;
  type?: ObjectType;
  library?: Library;
  status?: WorkStatus;
  /** 默认 false：过滤已软删除。 */
  includeDeleted?: boolean;
  /** 默认 false：过滤已归档。 */
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface LibraryChangeEvent {
  id: string;
  objectId: string;
  fromLibrary: Library;
  toLibrary: Library;
  reason: string;
  actorSub: string;
  createdAt: string;
}

export interface ChangeLibraryInput {
  objectId: string;
  to: Library;
  /** 必填的迁移理由，写入审计表。 */
  reason: string;
  actorSub: string;
  now?: string;
}

export interface ObjectRepository {
  create(input: CreateObjectInput): Promise<BusinessObject>;

  findById(id: string): Promise<BusinessObject | null>;

  list(query?: ListObjectsQuery): Promise<BusinessObject[]>;

  update(id: string, input: UpdateObjectInput): Promise<BusinessObject>;

  /** 软删除；不物理删除行，便于审计与对账。 */
  softDelete(id: string, at?: string): Promise<void>;

  /**
   * 跨库迁移：更新 library / libraryChangedAt / revision，并写入 library_events。
   * 迁移不会触碰内容（ADR-007），内容侧的 meta_fields 由 outbox 异步同步。
   */
  changeLibrary(input: ChangeLibraryInput): Promise<BusinessObject>;

  listLibraryEvents(objectId: string): Promise<LibraryChangeEvent[]>;
}
