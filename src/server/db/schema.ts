import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
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
    check(
      "objects_external_not_practiced",
      sql`NOT (library = 'external' AND status = 'practiced')`,
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
    index("objects_category_code_idx").on(table.categoryCode),
    /** 词法检索的候选面（ADR-024）：owner + 未删除 + 未归档。 */
    index("objects_owner_scope_idx").on(table.ownerSub, table.deletedAt, table.archivedAt),
    index("objects_type_status_idx").on(table.type, table.status),
    index("objects_library_idx").on(table.library),
    index("objects_updated_at_idx").on(table.updatedAt),
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
