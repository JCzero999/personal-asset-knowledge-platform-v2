import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 业务库表结构。时间统一 TEXT UTC ISO-8601，id 使用 ULID。
 *
 * 约束分工：允许的取值尽量用 CHECK 钉死在数据库里，应用层再给出可读错误；
 * 领域规则（状态机）在 `src/domain/workflow.ts` 重复实现，两层都不能省。
 */

export const objects = sqliteTable(
  "objects",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    library: text("library").notNull(),
    source: text("source").notNull(),
    origin: text("origin").notNull(),
    primaryCategory: text("primary_category"),
    categories: text("categories", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    priority: text("priority").notNull(),
    archivedAt: text("archived_at"),
    libraryChangedAt: text("library_changed_at"),
    ownerSub: text("owner_sub").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
    // 以下三列只有 work 有值，asset 必须为 NULL（status 由 CHECK 钉死）。
    format: text("format"),
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
    index("objects_type_status_idx").on(table.type, table.status),
    index("objects_library_idx").on(table.library),
    index("objects_updated_at_idx").on(table.updatedAt),
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
    objectId: text("object_id").notNull(),
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
    contentRefId: text("content_ref_id"),
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
    index("sync_jobs_state_idx").on(table.state, table.availableAt),
  ],
);

export type ObjectRow = typeof objects.$inferSelect;
export type NewObjectRow = typeof objects.$inferInsert;
export type ContentRefRow = typeof contentRefs.$inferSelect;
export type NewContentRefRow = typeof contentRefs.$inferInsert;
export type LibraryEventRow = typeof libraryEvents.$inferSelect;
export type NewLibraryEventRow = typeof libraryEvents.$inferInsert;
export type SyncJobRow = typeof syncJobs.$inferSelect;
export type NewSyncJobRow = typeof syncJobs.$inferInsert;
