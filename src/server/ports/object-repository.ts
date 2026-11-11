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
  // 新建作品一律从 draft 开始，状态只能经 changeStatus 迁移。
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
  /** 标题或描述包含该关键字（大小写不敏感）。 */
  search?: string;
  /** 分类或标签精确匹配其中之一。 */
  category?: string;
  tag?: string;
  /** 默认按更新时间倒序。 */
  sort?: "updated" | "created" | "title";
  /** 默认 false：过滤已软删除。 */
  includeDeleted?: boolean;
  /** 默认 false：过滤已归档；与 archivedOnly 同时为真时只看已归档。 */
  includeArchived?: boolean;
  /** 只返回已归档对象（归档视图）。 */
  archivedOnly?: boolean;
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
  /** 乐观锁：与库中 revision 不一致时抛 ConflictError；省略则按本次读取的 revision。 */
  expectedRevision?: number;
  now?: string;
}

export interface ChangeStatusInput {
  objectId: string;
  to: WorkStatus;
  /**
   * 乐观锁：与库中 revision 不一致时抛 ConflictError。
   * 省略则以本次读取到的 revision 作为条件，仍能挡住读取之后的并发写入。
   */
  expectedRevision?: number;
  now?: string;
}

export interface ObjectRepository {
  create(input: CreateObjectInput): Promise<BusinessObject>;

  findById(id: string): Promise<BusinessObject | null>;

  list(query?: ListObjectsQuery): Promise<BusinessObject[]>;

  update(id: string, input: UpdateObjectInput): Promise<BusinessObject>;

  /**
   * 作品状态迁移：按 `src/domain/workflow.ts` 的显式迁移表校验，非法迁移抛
   * INVALID_TRANSITION / EXTERNAL_LIBRARY_PRACTICED；资产没有状态、已归档作品
   * 不能推进状态（抛 CONFLICT）。
   */
  changeStatus(input: ChangeStatusInput): Promise<BusinessObject>;

  /** 软删除；不物理删除行，便于审计与对账。 */
  softDelete(id: string, at?: string): Promise<void>;

  /** 归档只改元数据（archivedAt），不移动内容；已归档时原样返回。 */
  archive(id: string, at?: string): Promise<BusinessObject>;

  unarchive(id: string, at?: string): Promise<BusinessObject>;

  /**
   * 跨库迁移：更新 library / libraryChangedAt / revision，并写入 library_events。
   * 迁移不会触碰内容（ADR-007），内容侧的 meta_fields 由 outbox 异步同步。
   */
  changeLibrary(input: ChangeLibraryInput): Promise<BusinessObject>;

  listLibraryEvents(objectId: string): Promise<LibraryChangeEvent[]>;
}
