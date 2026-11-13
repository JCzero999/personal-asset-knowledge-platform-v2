-- 形态与标签词表化（ADR-016）
-- 顺序很重要：先建词表并灌种子/存量标签，再重建 objects 去掉 tags 列并挂上 format 外键。
-- 外键开关必须由 openDatabase() 在迁移事务外层处理：事务内的 PRAGMA foreign_keys 是空操作。
CREATE TABLE `work_formats` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "work_formats_state_check" CHECK(state in ('active', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `work_formats_sort_idx` ON `work_formats` (`sort_order`);--> statement-breakpoint
-- 6 个内置形态 + 兜底「未分类」：code 与历史 workFormats 完全一致，存量 format 值天然合法。
INSERT INTO `work_formats` (`code`, `label`, `sort_order`, `state`, `is_system`, `created_at`, `updated_at`) VALUES
	('article', '文章', 10, 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	('script', '音视频脚本', 20, 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	('course', '课程', 30, 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	('live', '直播', 40, 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	('consult', '咨询', 50, 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	('flomo', '外部笔记', 60, 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	('uncategorized', '未分类', 999, 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`normalized` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_normalized_uq` ON `tags` (`normalized`);--> statement-breakpoint
-- 存量标签（objects.tags 的 JSON 数组）灌入词表：按 lower(trim()) 归一去重，
-- 展示写法取该键下最先遇到的一条。
INSERT INTO `tags` (`id`, `label`, `normalized`, `sort_order`, `created_at`, `updated_at`)
SELECT 'tag_' || lower(hex(randomblob(8))),
       min(trim(j.value)),
       lower(trim(j.value)),
       0,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `objects` AS o
JOIN json_each(o.`tags`) AS j ON 1
WHERE trim(j.value) <> ''
GROUP BY lower(trim(j.value));
--> statement-breakpoint
CREATE TABLE `object_tags` (
	`object_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`object_id`, `tag_id`),
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `object_tags_tag_idx` ON `object_tags` (`tag_id`);--> statement-breakpoint
-- 对象 ↔ 标签链接。软删对象也保留链接（ADR-016 风险 R3：使用次数统计靠 join 排除软删）。
INSERT INTO `object_tags` (`object_id`, `tag_id`)
SELECT DISTINCT o.`id`, t.`id`
FROM `objects` AS o
JOIN json_each(o.`tags`) AS j ON 1
JOIN `tags` AS t ON t.`normalized` = lower(trim(j.value))
WHERE trim(j.value) <> '';
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`library` text NOT NULL,
	`source` text NOT NULL,
	`origin` text NOT NULL,
	`primary_category` text,
	`categories` text DEFAULT '[]' NOT NULL,
	`priority` text NOT NULL,
	`archived_at` text,
	`library_changed_at` text,
	`owner_sub` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`format` text,
	`status` text,
	`source_note` text,
	FOREIGN KEY (`format`) REFERENCES `work_formats`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "objects_type_check" CHECK(type in ('asset', 'work')),
	CONSTRAINT "objects_library_check" CHECK(library in ('internal', 'external')),
	CONSTRAINT "objects_priority_check" CHECK(priority in ('low', 'medium', 'high')),
	CONSTRAINT "objects_source_check" CHECK(source in ('handwritten', 'ai_extracted')),
	CONSTRAINT "objects_origin_check" CHECK(origin in ('self', 'imported')),
	CONSTRAINT "objects_status_only_for_work" CHECK(type = 'work' OR status IS NULL),
	CONSTRAINT "objects_external_not_practiced" CHECK(NOT (library = 'external' AND status = 'practiced')),
	CONSTRAINT "objects_status_check" CHECK(status IS NULL OR status IN ('draft', 'finished', 'published', 'practiced')),
	CONSTRAINT "objects_asset_has_no_work_fields" CHECK(type = 'work' OR (format IS NULL AND source_note IS NULL)),
	CONSTRAINT "objects_work_requires_format" CHECK(type = 'asset' OR format IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_objects`("id", "type", "title", "description", "library", "source", "origin", "primary_category", "categories", "priority", "archived_at", "library_changed_at", "owner_sub", "revision", "created_at", "updated_at", "deleted_at", "format", "status", "source_note") SELECT "id", "type", "title", "description", "library", "source", "origin", "primary_category", "categories", "priority", "archived_at", "library_changed_at", "owner_sub", "revision", "created_at", "updated_at", "deleted_at", "format", "status", "source_note" FROM `objects`;--> statement-breakpoint
DROP TABLE `objects`;--> statement-breakpoint
ALTER TABLE `__new_objects` RENAME TO `objects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `objects_type_status_idx` ON `objects` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `objects_library_idx` ON `objects` (`library`);--> statement-breakpoint
CREATE INDEX `objects_updated_at_idx` ON `objects` (`updated_at`);
