-- 分类词表统一（ADR-023）：work_formats → categories，objects.format → objects.category_code
--
-- 规则（ADR-023 M1–M8）：
--   M1 作品分类 = 原 format code（7 个内置 code 原样保留）
--   M2 资产分类 = categories[0] 命中词表则复用，未命中则新建；无值则 NULL
--   M3 未成为该对象分类的自由值逐条转为标签（复用 tags.normalized）
--   M4 primary_category 直接删除（恒等于 categories[0]）
--   M5 新分类 code = 'c-' + 8 位小写十六进制
--   M7 原值等于内置分类 label → 复用（由 normalized 查重天然满足）
--   M8 原值等于「未分类」→ uncategorized（同上）
--
-- 与 ADR 骨架的差异：ADR 步骤 1 的示例 SQL 会把**全部**自由值先灌进 categories，
-- 再在步骤 3b 把非选中值转标签，结果留下一批 usage = 0 的分类词条（例如作品上
-- 只作为标签的「学习」）。这里按 M2/M3 的规范表述实现：只为资产的 categories[0]
-- 建分类，其余自由值直接成为标签。演练报告会逐条核对归宿。
--
-- 外键开关由 openDatabase() 在迁移事务外层处理（ADR-016 风险 R1）。
-- 整份迁移由 drizzle 包在单事务里，任一步失败即整体回滚；成功后回滚只能恢复备份。

-- ---------------------------------------------------------------------------
-- 第 1 步 · 建分类词表并灌入内置 7 项
-- ---------------------------------------------------------------------------
CREATE TABLE `categories` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`normalized` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "categories_state_check" CHECK(state in ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_normalized_uq` ON `categories` (`normalized`);--> statement-breakpoint
CREATE INDEX `categories_sort_idx` ON `categories` (`sort_order`);--> statement-breakpoint
INSERT INTO `categories` (`code`, `label`, `normalized`, `sort_order`, `state`, `is_system`, `created_at`, `updated_at`)
SELECT w.`code`, w.`label`, lower(trim(w.`label`)), w.`sort_order`, w.`state`, w.`is_system`, w.`created_at`, w.`updated_at`
FROM `work_formats` w
WHERE NOT EXISTS (SELECT 1 FROM `categories` c WHERE c.`code` = w.`code`);--> statement-breakpoint
-- 资产的 categories[0]：按 lower(trim()) 去重，词表里没有的才新建（M2/M5/M6）。
-- 展示名取同一归一键下 min(trim(value))，与 ADR M6 一致。
INSERT INTO `categories` (`code`, `label`, `normalized`, `sort_order`, `state`, `is_system`, `created_at`, `updated_at`)
SELECT 'c-' || lower(hex(randomblob(4))), v.`label`, v.`norm`, 500, 'active', 0,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM (
  SELECT lower(trim(json_extract(o.`categories`, '$[0]'))) AS norm,
         min(trim(json_extract(o.`categories`, '$[0]'))) AS label
  FROM `objects` o
  WHERE o.`type` = 'asset'
    AND trim(coalesce(json_extract(o.`categories`, '$[0]'), '')) <> ''
  GROUP BY lower(trim(json_extract(o.`categories`, '$[0]')))
) v
WHERE NOT EXISTS (SELECT 1 FROM `categories` c WHERE c.`normalized` = v.`norm`);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 第 2 步 · 留档（删除前把三列原样存一份，供回滚与人工重建旧视图）
-- ---------------------------------------------------------------------------
CREATE TABLE `objects_category_legacy_backup` AS
SELECT `id` AS object_id, `categories`, `primary_category`, `format` FROM `objects`;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 第 3 步 · 每个对象的分类码（作品看 format，资产看 categories[0]）
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE `_object_category` AS
SELECT o.`id` AS object_id,
       CASE
         WHEN o.`type` = 'work' THEN o.`format`
         ELSE (SELECT c.`code` FROM `categories` c
               WHERE c.`normalized` = lower(trim(json_extract(o.`categories`, '$[0]')))
               LIMIT 1)
       END AS category_code
FROM `objects` o;--> statement-breakpoint

-- 3b) 未成为该对象分类的自由值 → 标签（复用已有 normalized，缺的先补建）
INSERT INTO `tags` (`id`, `label`, `normalized`, `sort_order`, `created_at`, `updated_at`)
SELECT 'tag_' || lower(hex(randomblob(8))), v.`label`, v.`norm`, 0,
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM (
  SELECT lower(trim(j.value)) AS norm, min(trim(j.value)) AS label
  FROM `objects` o, json_each(o.`categories`) j
  JOIN `_object_category` oc ON oc.`object_id` = o.`id`
  LEFT JOIN `categories` c ON c.`code` = oc.`category_code`
  WHERE trim(j.value) <> ''
    AND (c.`normalized` IS NULL OR lower(trim(j.value)) <> c.`normalized`)
  GROUP BY lower(trim(j.value))
) v
WHERE NOT EXISTS (SELECT 1 FROM `tags` t WHERE t.`normalized` = v.`norm`);--> statement-breakpoint
INSERT OR IGNORE INTO `object_tags` (`object_id`, `tag_id`)
SELECT DISTINCT o.`id`, t.`id`
FROM `objects` o, json_each(o.`categories`) j
JOIN `_object_category` oc ON oc.`object_id` = o.`id`
LEFT JOIN `categories` c ON c.`code` = oc.`category_code`
JOIN `tags` t ON t.`normalized` = lower(trim(j.value))
WHERE trim(j.value) <> ''
  AND (c.`normalized` IS NULL OR lower(trim(j.value)) <> c.`normalized`);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 第 4 步 · 重建 objects（去掉 format / categories / primary_category，挂分类外键）
-- ---------------------------------------------------------------------------
CREATE TABLE `__new_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`library` text NOT NULL,
	`source` text NOT NULL,
	`origin` text NOT NULL,
	`category_code` text,
	`priority` text NOT NULL,
	`archived_at` text,
	`library_changed_at` text,
	`owner_sub` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`status` text,
	`source_note` text,
	FOREIGN KEY (`category_code`) REFERENCES `categories`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "objects_type_check" CHECK(type in ('asset', 'work')),
	CONSTRAINT "objects_library_check" CHECK(library in ('internal', 'external')),
	CONSTRAINT "objects_priority_check" CHECK(priority in ('low', 'medium', 'high')),
	CONSTRAINT "objects_source_check" CHECK(source in ('handwritten', 'ai_extracted')),
	CONSTRAINT "objects_origin_check" CHECK(origin in ('self', 'imported')),
	CONSTRAINT "objects_status_only_for_work" CHECK(type = 'work' OR status IS NULL),
	CONSTRAINT "objects_external_not_practiced" CHECK(NOT (library = 'external' AND status = 'practiced')),
	CONSTRAINT "objects_status_check" CHECK(status IS NULL OR status IN ('draft', 'finished', 'published', 'practiced')),
	CONSTRAINT "objects_asset_has_no_source_note" CHECK(type = 'work' OR source_note IS NULL),
	CONSTRAINT "objects_work_requires_category" CHECK(type = 'asset' OR category_code IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_objects`("id", "type", "title", "description", "library", "source", "origin", "category_code", "priority", "archived_at", "library_changed_at", "owner_sub", "revision", "created_at", "updated_at", "deleted_at", "status", "source_note")
SELECT o."id", o."type", o."title", o."description", o."library", o."source", o."origin", oc."category_code", o."priority", o."archived_at", o."library_changed_at", o."owner_sub", o."revision", o."created_at", o."updated_at", o."deleted_at", o."status", o."source_note"
FROM `objects` o
JOIN `_object_category` oc ON oc.`object_id` = o.`id`;--> statement-breakpoint
DROP TABLE `objects`;--> statement-breakpoint
ALTER TABLE `__new_objects` RENAME TO `objects`;--> statement-breakpoint
CREATE INDEX `objects_category_code_idx` ON `objects` (`category_code`);--> statement-breakpoint
CREATE INDEX `objects_type_status_idx` ON `objects` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `objects_library_idx` ON `objects` (`library`);--> statement-breakpoint
CREATE INDEX `objects_updated_at_idx` ON `objects` (`updated_at`);--> statement-breakpoint
DROP TABLE `_object_category`;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 第 5 步 · 旧词表退场
-- ---------------------------------------------------------------------------
DROP TABLE `work_formats`;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 第 6 步 · 权限键改名（role_permissions 外键 ON UPDATE NO ACTION，只能插入-复制-删除）
-- ---------------------------------------------------------------------------
INSERT INTO `permissions` (`key`, `label`, `group_key`, `sort_order`)
SELECT 'vocabulary:category:write', '管理分类词表', `group_key`, `sort_order`
FROM `permissions` WHERE `key` = 'vocabulary:format:write';--> statement-breakpoint
INSERT INTO `role_permissions` (`role_key`, `permission_key`)
SELECT `role_key`, 'vocabulary:category:write'
FROM `role_permissions` WHERE `permission_key` = 'vocabulary:format:write';--> statement-breakpoint
DELETE FROM `role_permissions` WHERE `permission_key` = 'vocabulary:format:write';--> statement-breakpoint
DELETE FROM `permissions` WHERE `key` = 'vocabulary:format:write';
