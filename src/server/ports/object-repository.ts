import type {
  AiStatus,
  AssetSourceType,
  BusinessObject,
  Category,
  Library,
  ObjectOrigin,
  ObjectSource,
  ObjectType,
  Priority,
  ValueLevel,
  WorkStatus,
} from "../../domain/objects";
import type { AiScoreDetail, ValueScores } from "../../domain/value";
import type { ActorContext } from "../authz";

/**
 * 业务对象仓储端口。
 *
 * 接口职责是「持久化 + 最小一致性」，不在这里做权限、内容同步或外部调用；
 * 需要那些能力的实现留在 `server/services`（本轮只有占位）。
 *
 * 跨表、跨行必须同时成立的操作（打分入库、实践结算、价值重评）都收敛成
 * 单个方法：一次调用 = 一个 SQLite 事务，调用方拿不到「一半成功」的中间态。
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
  tags?: string[];
  priority?: Priority;
  ownerSub: string;
  // ---- 分类（ADR-023）：作品必填、资产可空 ----
  category?: Category | null;
  // ---- 仅 work ----
  // 新建作品一律从 draft 开始，状态只能经 changeStatus 迁移。
  sourceNote?: string | null;
  // ---- 仅 asset（ADR-029）----
  sourceType?: AssetSourceType | null;
  aiStatus?: AiStatus | null;
  /** 仅用于「实践结算」这类一次成型的内库资产。 */
  valueLevel?: ValueLevel | null;
  valueScores?: ValueScores | null;
  valueAssessedAt?: string | null;
  /** practiced_work 资产的来源作品。 */
  originWorkId?: string | null;
  /** 由实现注入统一时钟；主要在测试中使用。 */
  now?: string;
}

export interface UpdateObjectInput {
  title?: string;
  description?: string | null;
  source?: ObjectSource;
  origin?: ObjectOrigin;
  tags?: string[];
  priority?: Priority;
  /** 作品不能改成 null；资产可以清空。 */
  category?: Category | null;
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
  /** 资产 AI 处置状态（ADR-029）；作品没有该字段，命中数为 0。 */
  aiStatus?: AiStatus;
  /** 内库资产价值等级（ADR-029）。 */
  valueLevel?: ValueLevel;
  /** 标题或描述包含该关键字（大小写不敏感）。 */
  search?: string;
  /** 分类：按 code 匹配；传入中文名称时按 normalized 解析（ADR-023 矩阵第 27 条）。 */
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

export interface LexicalTermFilter {
  /** null 表示标题 / 描述 / 分类 / 标签任一字段命中即可。 */
  field: "title" | "description" | "category" | "tag" | null;
  /** 已归一化的检索值（normalizeSearchText）。 */
  value: string;
  negated: boolean;
}

export interface LexicalSearchInput {
  ownerSub: string;
  terms: readonly LexicalTermFilter[];
  library?: Library;
  /** 默认 500（ADR-024 上限）。 */
  limit?: number;
}

export interface LexicalCandidate {
  object: BusinessObject;
  /** 分类展示名；对象无分类时为 null。 */
  categoryLabel: string | null;
}

export interface LexicalSearchResult {
  /** 已按 owner / 软删 / 归档 / 库别过滤的候选，最多 `limit` 条。 */
  candidates: LexicalCandidate[];
  /** 命中超过上限时 true（SQL 多取一条判断）。 */
  truncated: boolean;
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
  /** 审计用的本地用户 id；`users` 行被删除后审计仍靠 actorSub 可读。 */
  actorUserId?: string | null;
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

/** 一次价值评估的结果（5 维），写入 `value_*` 三列。 */
export interface ValueAssessmentInput {
  valueLevel: ValueLevel;
  valueScores: ValueScores;
  valueAssessedAt: string;
}

/** 6 维打分入库：auto_pass 时同事务完成「转内库 + 挂 5 维评估」。 */
export interface ApplyAiScoreInput {
  objectId: string;
  expectedRevision?: number;
  detail: AiScoreDetail;
  /** detail.verdict 为 auto_pass 时必须给出（内库资产不允许没有等级）。 */
  assessment?: ValueAssessmentInput | null;
  actor: ActorContext;
  now?: string;
}

/** 人工复核入库：approve 时同事务转内库并挂 5 维评估，reject 时降到低价值。 */
export interface ReviewAssetInput {
  objectId: string;
  expectedRevision?: number;
  decision: "approve" | "reject";
  note: string | null;
  assessment?: ValueAssessmentInput | null;
  actor: ActorContext;
  now?: string;
}

export interface ApplyValueAssessmentInput {
  objectId: string;
  expectedRevision?: number;
  assessment: ValueAssessmentInput;
  actor: ActorContext;
  now?: string;
}

/** 实践结算：建内库资产 + 推进作品状态（保留可查、不归档），必须原子完成。 */
export interface SettlePracticeInput {
  workId: string;
  expectedRevision?: number;
  metrics: Record<string, unknown> | null;
  assessment: ValueAssessmentInput;
  asset: {
    id?: string;
    title: string;
    description: string | null;
    category: Category | null;
    tags: string[];
    priority: Priority;
    source: ObjectSource;
    origin: ObjectOrigin;
  };
  actor: ActorContext;
  now?: string;
}

export interface SettlePracticeResult {
  work: BusinessObject;
  asset: BusinessObject;
}

export interface ObjectRepository {
  create(input: CreateObjectInput): Promise<BusinessObject>;

  findById(id: string): Promise<BusinessObject | null>;

  /**
   * 提炼幂等：返回来源为该作品、`source_type = ai_extract` 且未删除的资产
   * （最早的优先）；没有则 null。用户删除旧资产后允许重新提炼。
   */
  findExtractedByOriginWork(originWorkId: string): Promise<BusinessObject | null>;

  list(query?: ListObjectsQuery): Promise<BusinessObject[]>;

  /**
   * 词法候选（ADR-024）：只做「归属 + 未删除 + 未归档 + 库别 + 关键词」过滤，
   * 不在这里排序；评分与对象级去重由 `lexical-search-service` 完成。
   */
  lexicalSearch(input: LexicalSearchInput): Promise<LexicalSearchResult>;

  update(id: string, input: UpdateObjectInput): Promise<BusinessObject>;

  /**
   * 作品状态迁移：按 `src/domain/workflow.ts` 的显式迁移表校验，非法迁移抛
   * INVALID_TRANSITION；资产没有状态、已归档作品不能推进状态（抛 CONFLICT）。
   *
   * `to === "practiced"` 不在这里落地：标记已实践必须同时沉淀内库资产，
   * 走 `settlePractice`（一次性事务），这里直接拒绝。
   */
  changeStatus(input: ChangeStatusInput): Promise<BusinessObject>;

  /** 软删除；不物理删除行，便于审计与对账。传入 actor 时同事务写审计。 */
  softDelete(id: string, at?: string, actor?: ActorContext): Promise<void>;

  /** 归档只改元数据（archivedAt），不移动内容；已归档时原样返回。 */
  archive(id: string, at?: string, actor?: ActorContext): Promise<BusinessObject>;

  unarchive(id: string, at?: string, actor?: ActorContext): Promise<BusinessObject>;

  /**
   * 跨库迁移：更新 library / libraryChangedAt / revision，并写入 library_events。
   * 迁移不会触碰内容（ADR-007），内容侧的 meta_fields 由 outbox 异步同步。
   * 作品只存在于外库，迁入内库一律拒绝（WORK_MUST_BE_EXTERNAL）；
   * 外库资产迁入内库同样拒绝（LIBRARY_ENTRY_DENIED），只能经打分或复核进入。
   */
  changeLibrary(input: ChangeLibraryInput): Promise<BusinessObject>;

  listLibraryEvents(objectId: string): Promise<LibraryChangeEvent[]>;

  /** 6 维打分结果入库；auto_pass 时同事务转内库并挂上 5 维评估。 */
  applyAiScore(input: ApplyAiScoreInput): Promise<BusinessObject>;

  /** 人工复核：approve 转内库 + 评估 + approved；reject 记为低价值（留在外库）。 */
  reviewAsset(input: ReviewAssetInput): Promise<BusinessObject>;

  /** 内库资产重评：只更新 `value_*` 三列。 */
  applyValueAssessment(input: ApplyValueAssessmentInput): Promise<BusinessObject>;

  /** 实践结算：单事务建内库资产 + 作品 practiced / 回指资产（不归档）。 */
  settlePractice(input: SettlePracticeInput): Promise<SettlePracticeResult>;
}
