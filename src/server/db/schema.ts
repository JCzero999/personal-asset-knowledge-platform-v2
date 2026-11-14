import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

/**
 * 业务库表结构。时间统一 TEXT UTC ISO-8601，id 使用 ULID。
 *
 * 约束分工：允许的取值尽量用 CHECK 钉死在数据库里，应用层再给出可读错误；
 * 领域规则（状态机）在 `src/domain/workflow.ts` 重复实现，两层都不能省。
 */

/**
 * 分类词表（ADR-023）。`code` 是主键且一经创建不可改——改名只动 label，
 * 因此 `objects.category_code` 的存量值天然就是合法的外键值。
 *
 * `normalized` 是查重键：`displayLabel`（NFKC、连续空白压成一个、trim）后小写；
 * 重命名只改 label，同时重算 normalized，冲突返回 409。
 */
export const categories = sqliteTable(
  "categories",
  {
    code: text("code").primaryKey(),
    label: text("label").notNull(),
    normalized: text("normalized").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** active 才出现在新建面板；archived 只影响新建，历史对象照常显示。 */
    state: text("state").notNull().default("active"),
    /** 内置分类不可删除（只能改名、排序、停用）。 */
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("categories_state_check", sql`state in ('active', 'archived')`),
    uniqueIndex("categories_normalized_uq").on(table.normalized),
    index("categories_sort_idx").on(table.sortOrder),
  ],
);

/** 标签词表：`normalized` 唯一，重命名只改 label（object_tags 存的是 id）。 */
export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    normalized: text("normalized").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("tags_normalized_uq").on(table.normalized)],
);

export const objects = sqliteTable(
  "objects",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** 检索影子列（ADR-024）：NFKC + 小写 + 空白收敛，写入与查询共用 normalizeSearchText。 */
    titleNorm: text("title_norm"),
    descriptionNorm: text("description_norm"),
    library: text("library").notNull(),
    source: text("source").notNull(),
    origin: text("origin").notNull(),
    /** 分类（ADR-023）：作品必有、资产可空；外键指向 categories.code。 */
    categoryCode: text("category_code").references(() => categories.code),
    priority: text("priority").notNull(),
    archivedAt: text("archived_at"),
    libraryChangedAt: text("library_changed_at"),
    ownerSub: text("owner_sub").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
    // 以下两列只有 work 有值，asset 必须为 NULL（status 由 CHECK 钉死）。
    status: text("status"),
    sourceNote: text("source_note"),
    // ---- 作品生命周期（ADR-029）：只有 work 有值 ----
    publishedAt: text("published_at"),
    practicedAt: text("practiced_at"),
    /** 实践数据快照（跳出率等），JSON 文本。 */
    practiceMetrics: text("practice_metrics"),
    /** 实践结算出的内库资产 id：一个作品最多结算一次（唯一索引）。 */
    settledAssetId: text("settled_asset_id").references((): AnySQLiteColumn => objects.id),
    // ---- 资产流转（ADR-029）：只有 asset 有值 ----
    sourceType: text("source_type"),
    aiStatus: text("ai_status"),
    aiScore: integer("ai_score"),
    aiScoreDetail: text("ai_score_detail"),
    valueLevel: text("value_level"),
    valueScores: text("value_scores"),
    valueAssessedAt: text("value_assessed_at"),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: text("last_used_at"),
    /** 手动锁定等级：自动升降级跳过锁定资产（v2.1 §2）。 */
    valueLevelLocked: integer("value_level_locked", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 沉淀时的正文 sha256 与前 2000 字快照（v2.1 §4）。 */
    contentHash: text("content_hash"),
    contentSnapshot: text("content_snapshot"),
    contentSnapshotAt: text("content_snapshot_at"),
    /** 最近一次自动升降级时间：24 小时内不再调整（v2.1 §2 安全阀）。 */
    lastLevelAdjustAt: text("last_level_adjust_at"),
    /** practiced_work 资产的来源作品。 */
    originWorkId: text("origin_work_id").references((): AnySQLiteColumn => objects.id),
  },
  (table) => [
    check("objects_type_check", sql`type in ('asset', 'work')`),
    check("objects_library_check", sql`library in ('internal', 'external')`),
    check("objects_priority_check", sql`priority in ('low', 'medium', 'high')`),
    check("objects_source_check", sql`source in ('handwritten', 'ai_extracted')`),
    check("objects_origin_check", sql`origin in ('self', 'imported')`),
    check(
      "objects_status_only_for_work",
      sql`type = 'work' OR status IS NULL`,
    ),
    // 作品只存在于外库（ADR-029 取代 ADR-008）：内库只有资产。
    check("objects_work_must_be_external", sql`type = 'asset' OR library = 'external'`),
    // 「已实践」是外库作品的手动确认，内库不存在作品，因此这是冗余但廉价的护栏。
    check(
      "objects_practiced_requires_external",
      sql`status IS NULL OR status <> 'practiced' OR library = 'external'`,
    ),
    // 取值域：应用层已收敛，这里钉死，避免绕过服务层写入脏值。
    check(
      "objects_status_check",
      sql`status IS NULL OR status IN ('draft', 'finished', 'published', 'practiced')`,
    ),
    // 分类已词表化（ADR-023），取值由 categories 外键保证。
    // 资产不带来源说明；作品必须有分类。
    check(
      "objects_asset_has_no_source_note",
      sql`type = 'work' OR source_note IS NULL`,
    ),
    check("objects_work_requires_category", sql`type = 'asset' OR category_code IS NOT NULL`),
    // 作品专属字段对资产为 NULL；资产专属字段对作品为 NULL（use_count 保持 0）。
    check(
      "objects_work_only_fields",
      sql`type = 'work' OR (published_at IS NULL AND practiced_at IS NULL
            AND practice_metrics IS NULL AND settled_asset_id IS NULL)`,
    ),
    check(
      "objects_asset_only_fields",
      sql`type = 'asset' OR (source_type IS NULL AND ai_status IS NULL AND ai_score IS NULL
            AND ai_score_detail IS NULL AND value_level IS NULL AND value_scores IS NULL
            AND value_assessed_at IS NULL AND use_count = 0 AND last_used_at IS NULL
            AND origin_work_id IS NULL)`,
    ),
    check(
      "objects_source_type_check",
      sql`source_type IS NULL OR source_type IN ('ai_extract', 'external_direct', 'practiced_work')`,
    ),
    check(
      "objects_ai_status_check",
      sql`ai_status IS NULL OR ai_status IN
            ('unscored', 'auto_pass', 'needs_review', 'low_value', 'approved', 'rejected')`,
    ),
    check("objects_ai_score_check", sql`ai_score IS NULL OR (ai_score >= 0 AND ai_score <= 100)`),
    check("objects_value_level_check", sql`value_level IS NULL OR value_level IN ('S','A','B','C')`),
    check("objects_use_count_check", sql`use_count >= 0`),
    // 规格 v2.0 规则 4：内库资产必须有 5 维分与等级。服务层在自动入库、
    // 人工复核、实践结算时都会写这三列；数据库这里做最后一道，防止崩溃或
    // 绕过服务层的直写留下「进了内库却没评估」的资产。
    check(
      "objects_internal_asset_requires_value",
      sql`type <> 'asset' OR library <> 'internal'
            OR (value_level IS NOT NULL AND value_scores IS NOT NULL
                AND value_assessed_at IS NOT NULL)`,
    ),
    index("objects_category_code_idx").on(table.categoryCode),
    /** 词法检索的候选面（ADR-024）：owner + 未删除 + 未归档。 */
    index("objects_owner_scope_idx").on(table.ownerSub, table.deletedAt, table.archivedAt),
    index("objects_type_status_idx").on(table.type, table.status),
    index("objects_library_idx").on(table.library),
    index("objects_updated_at_idx").on(table.updatedAt),
    index("objects_ai_status_idx").on(table.type, table.aiStatus),
    index("objects_value_level_idx").on(table.type, table.valueLevel),
    // 一个作品最多结算出一个内库资产：并发点两次「已实践」也不会产生两条资产。
    // 只约束 practiced_work：同一草稿可以产出多条 ai_extract 资产（origin_work_id
    // 是来源线索，不是唯一键）；提炼幂等由服务层查重保证。
    uniqueIndex("objects_origin_work_uq")
      .on(table.originWorkId)
      .where(sql`origin_work_id IS NOT NULL AND source_type = 'practiced_work'`),
  ],
);

/**
 * 对象 ↔ 标签。标签是内容的属性，资产也允许打标签（R2）。
 *
 * 两侧都 ON DELETE CASCADE：真删对象 / 删标签时链接自然消失；对象是软删除，
 * 行还在，级联不会触发——因此「使用次数」统计必须显式 join objects 并排除
 * `deleted_at`（ADR-016 风险 R3）。
 */
export const objectTags = sqliteTable(
  "object_tags",
  {
    objectId: text("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.objectId, table.tagId] }),
    index("object_tags_tag_idx").on(table.tagId),
  ],
);

export const contentRefs = sqliteTable(
  "content_refs",
  {
    id: text("id").primaryKey(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    /** 固定为 ragflow（单一内容底座，ADR-005/007）。 */
    provider: text("provider").notNull(),
    datasetId: text("dataset_id").notNull(),
    /**
     * 可变指针，不是身份：RAGFlow 正文更新是「删除 + 重传」，document_id 会变。
     * 身份/幂等键是 content_key。
     */
    documentId: text("document_id").notNull(),
    contentKey: text("content_key").notNull(),
    role: text("role").notNull(),
    documentName: text("document_name"),
    contentHash: text("content_hash"),
    mime: text("mime"),
    sizeBytes: integer("size_bytes"),
    parseStatus: text("parse_status").notNull().default("pending"),
    parseError: text("parse_error"),
    syncState: text("sync_state").notNull().default("pending"),
    lastSyncedAt: text("last_synced_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    check("content_refs_owner_type_check", sql`owner_type in ('asset', 'work')`),
    check("content_refs_provider_check", sql`provider = 'ragflow'`),
    check("content_refs_role_check", sql`role in ('primary', 'attachment')`),
    check("content_refs_dataset_id_check", sql`length(dataset_id) > 0`),
    check("content_refs_document_id_check", sql`length(document_id) > 0`),
    check("content_refs_content_key_check", sql`length(content_key) > 0`),
    check(
      "content_refs_parse_status_check",
      sql`parse_status in ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check(
      "content_refs_sync_state_check",
      sql`sync_state in ('pending', 'synced', 'sync_failed', 'deleted')`,
    ),
    uniqueIndex("content_refs_dataset_document_uq").on(table.datasetId, table.documentId),
    uniqueIndex("content_refs_dataset_content_key_uq").on(table.datasetId, table.contentKey),
    // 每个对象最多一个有效的主内容引用。
    uniqueIndex("content_refs_primary_owner_uq")
      .on(table.ownerType, table.ownerId)
      .where(sql`role = 'primary' AND deleted_at IS NULL`),
    index("content_refs_owner_idx").on(table.ownerType, table.ownerId),
  ],
);

export const libraryEvents = sqliteTable(
  "library_events",
  {
    id: text("id").primaryKey(),
    objectId: text("object_id")
      .notNull()
      .references(() => objects.id),
    fromLibrary: text("from_library").notNull(),
    toLibrary: text("to_library").notNull(),
    /** 迁移理由，必填：内库是「已验证」的承诺，需要可追溯。 */
    reason: text("reason").notNull(),
    /** 谁做的：当前为 Logto sub，Phase 1 单用户也照实记录。 */
    actorSub: text("actor_sub").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("library_events_from_check", sql`from_library in ('internal', 'external')`),
    check("library_events_to_check", sql`to_library in ('internal', 'external')`),
    // 迁移记录必须真正跨库，同库记录没有审计意义。
    check("library_events_cross_check", sql`from_library <> to_library`),
    index("library_events_object_idx").on(table.objectId, table.createdAt),
  ],
);

/**
 * 同步 outbox：内容变更即入队，Phase 3 由 LightRAG worker 消费。
 * 这里只负责可靠落队，不实现投递。
 */
export const syncJobs = sqliteTable(
  "sync_jobs",
  {
    id: text("id").primaryKey(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    contentRefId: text("content_ref_id").references(() => contentRefs.id),
    action: text("action").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    availableAt: text("available_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("sync_jobs_action_check", sql`action in ('upsert', 'delete')`),
    check("sync_jobs_state_check", sql`state in ('pending', 'running', 'done', 'failed')`),
    // 同一对象同一动作最多一个活跃任务：重复入队直接返回已有任务（outbox 去重）。
    uniqueIndex("sync_jobs_active_uq")
      .on(
        table.ownerType,
        table.ownerId,
        sql`coalesce(${table.contentRefId}, '')`,
        table.action,
      )
      .where(sql`state in ('pending', 'running')`),
    index("sync_jobs_state_idx").on(table.state, table.availableAt),
  ],
);

/**
 * 授权六表（ADR-019）。Logto 只证明 `sub`，授权真相源全在这里。
 *
 * 时间统一 TEXT UTC ISO-8601；`id` 仍是 ULID。`users.sub` 唯一但不作主键：
 * 将来换 IdP 只改 sub 一处，外键与审计不受影响。
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    sub: text("sub").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    state: text("state").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("users_sub_uq").on(table.sub),
    check("users_state_check", sql`state in ('active', 'disabled')`),
  ],
);

export const roles = sqliteTable("roles", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const permissions = sqliteTable("permissions", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  groupKey: text("group_key").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.roleKey, table.permissionKey] })],
);

export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleKey] }),
    index("user_roles_role_idx").on(table.roleKey),
  ],
);

/**
 * 审计表。`actor_user_id` 故意不加外键：用户被删或 `sub` 变更后审计仍要可读，
 * 因此只存 `actor_sub` 快照（ADR-019 第 8 条）。表本身不级联删除。
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorSub: text("actor_sub").notNull(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detail: text("detail"),
    result: text("result").notNull().default("ok"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("audit_events_result_check", sql`result in ('ok', 'error', 'denied')`),
    index("audit_events_created_idx").on(table.createdAt),
    index("audit_events_actor_idx").on(table.actorUserId, table.createdAt),
    index("audit_events_target_idx").on(table.targetType, table.targetId),
  ],
);

/**
 * 资产使用事件（规格 v2.1 §2）：一次记录 = 一次明确动作。
 *
 * `use_count` 是累计快照，事件流才是「最近 30 天用了几次」的事实来源；
 * 同一资产同一动作同一人 1 小时内只记一次（服务层去重）。
 */
export const assetUsageEvents = sqliteTable(
  "asset_usage_events",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    occurredAt: text("occurred_at").notNull(),
    actorSub: text("actor_sub").notNull(),
  },
  (table) => [
    check(
      "asset_usage_events_kind_check",
      sql`kind in ('detail_dwell', 'open_source', 'copy', 'reference')`,
    ),
    index("asset_usage_events_asset_time_idx").on(table.assetId, table.occurredAt),
  ],
);

/**
 * 价值评估历史（规格 v2.1 §3，append-only）。
 *
 * 所有写 `objects.value_*` 的路径都先插一条历史再更新主表；`prev_*` 是更新前
 * 的旧值，创建/沉淀/复核时为 NULL。`assessed_by` 存 actor sub、`system` 或
 * `migration`，不设外键——用户删除后历史仍要可读。
 */
export const valueAssessmentHistory = sqliteTable(
  "value_assessment_history",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    assessedAt: text("assessed_at").notNull(),
    assessedBy: text("assessed_by").notNull(),
    trigger: text("trigger").notNull(),
    valueLevel: text("value_level").notNull(),
    valueScores: text("value_scores"),
    prevLevel: text("prev_level"),
    prevScores: text("prev_scores"),
    reason: text("reason"),
  },
  (table) => [
    check(
      "value_assessment_history_level_check",
      sql`value_level in ('S', 'A', 'B', 'C')`,
    ),
    check(
      "value_assessment_history_prev_level_check",
      sql`prev_level is null or prev_level in ('S', 'A', 'B', 'C')`,
    ),
    check(
      "value_assessment_history_trigger_check",
      sql`"trigger" in ('create', 'settle', 'review', 'manual_reassess',
            'auto_upgrade', 'auto_downgrade', 'migration')`,
    ),
    index("value_assessment_history_asset_time_idx").on(table.assetId, table.assessedAt),
  ],
);

/**
 * 系统设置（ADR-025）。
 *
 * 值整段加密（`v1.<iv>.<tag>.<ciphertext>`，AES-256-GCM），密钥由
 * 独立变量 `SETTINGS_ENC_KEY` 经 HKDF-SHA256 派生；读取路径只在内存里解密，
 * 接口只回掩码。不做外键：`updated_by` 是 sub 快照，用户删除后仍要可读。
 */
export const settings = sqliteTable(
  "settings",
  {
    key: text("key").primaryKey(),
    valueEncrypted: text("value_encrypted").notNull(),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  () => [check("settings_key_check", sql`length(key) > 0`)],
);

export type ObjectRow = typeof objects.$inferSelect;
export type NewObjectRow = typeof objects.$inferInsert;
export type CategoryRow = typeof categories.$inferSelect;
export type NewCategoryRow = typeof categories.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
export type NewTagRow = typeof tags.$inferInsert;
export type ObjectTagRow = typeof objectTags.$inferSelect;
export type ContentRefRow = typeof contentRefs.$inferSelect;
export type NewContentRefRow = typeof contentRefs.$inferInsert;
export type LibraryEventRow = typeof libraryEvents.$inferSelect;
export type NewLibraryEventRow = typeof libraryEvents.$inferInsert;
export type SyncJobRow = typeof syncJobs.$inferSelect;
export type NewSyncJobRow = typeof syncJobs.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type RoleRow = typeof roles.$inferSelect;
export type PermissionRow = typeof permissions.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
export type AssetUsageEventRow = typeof assetUsageEvents.$inferSelect;
export type NewAssetUsageEventRow = typeof assetUsageEvents.$inferInsert;
export type ValueAssessmentHistoryRow = typeof valueAssessmentHistory.$inferSelect;
export type NewValueAssessmentHistoryRow = typeof valueAssessmentHistory.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
