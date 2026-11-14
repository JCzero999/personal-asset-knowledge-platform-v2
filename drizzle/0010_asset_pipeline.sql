-- 内容流转与沉淀（ADR-029，取代 ADR-008 的「先迁内库才能已实践」）
--
-- 规格 v2.0 第 3–7 节的落库形态：
--   * 作品只存在于外库；「已实践」是外库作品的手动确认，并在同一事务里
--     立即沉淀为内库资产（原先的 objects_external_not_practiced 反向作废）。
--   * 资产新增 AI 处置状态（6 维打分）与内库价值等级（5 维评估）。
--   * 存量内库作品（旧模型里「已验证的作品」）迁移为内库资产，
--     source_type = practiced_work、origin_work_id 指回原作品；原作品保留
--     practiced 状态继续可查，不自动归档。
--
-- 约定：
--   published_at / practiced_at / practice_metrics / settled_asset_id 只有 work 有值；
--   source_type / ai_status / ai_score / ai_score_detail / value_level / value_scores /
--   value_assessed_at / last_used_at / origin_work_id 只有 asset 有值（use_count 恒 0）。
--   两边都由 CHECK 钉死，服务层再给可读错误。
--
-- 外键开关由 openDatabase() 在迁移事务外层处理（ADR-016 风险 R1）；
-- 整份迁移由 drizzle 包在单事务里，失败即整体回滚。

-- ---------------------------------------------------------------------------
-- 第 0 步 · 内库存量资产的 5 维兜底：全维 2 分 → C 级，标注 source = migration
--           （外库资产保持 value_* 全 NULL，等真正入库时再评估）
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE `_value_backfill` AS
SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS assessed_at,
       json_object(
         'dimensions', json_array(
           json_object('key','practice','label','实践验证强度','score',2,'reason',''),
           json_object('key','reuse','label','复用频率 / 复利潜力','score',2,'reason',''),
           json_object('key','transferability','label','可迁移性','score',2,'reason',''),
           json_object('key','uniqueness','label','独特性 / 稀缺性','score',2,'reason',''),
           json_object('key','timeliness','label','时效性 / 衰减速度','score',2,'reason','')
         ),
         'average', 2.0,
         'level', 'C',
         'model', NULL,
         'assessedAt', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         'source', 'migration'
       ) AS value_scores;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 第 1 步 · 需要转成内库资产的内库作品（旧模型遗留）
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE `_settled_work` AS
SELECT o.*, ('01' || upper(hex(randomblob(12)))) AS asset_id
FROM `objects` o
WHERE o.`type` = 'work' AND o.`library` = 'internal';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 第 2 步 · 重建 objects
-- ---------------------------------------------------------------------------
CREATE TABLE `__new_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`title_norm` text,
	`description_norm` text,
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
	`published_at` text,
	`practiced_at` text,
	`practice_metrics` text,
	`settled_asset_id` text,
	`source_type` text,
	`ai_status` text,
	`ai_score` integer,
	`ai_score_detail` text,
	`value_level` text,
	`value_scores` text,
	`value_assessed_at` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`origin_work_id` text,
	FOREIGN KEY (`category_code`) REFERENCES `categories`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`settled_asset_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_work_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "objects_type_check" CHECK(type in ('asset', 'work')),
	CONSTRAINT "objects_library_check" CHECK(library in ('internal', 'external')),
	CONSTRAINT "objects_priority_check" CHECK(priority in ('low', 'medium', 'high')),
	CONSTRAINT "objects_source_check" CHECK(source in ('handwritten', 'ai_extracted')),
	CONSTRAINT "objects_origin_check" CHECK(origin in ('self', 'imported')),
	CONSTRAINT "objects_status_only_for_work" CHECK(type = 'work' OR status IS NULL),
	CONSTRAINT "objects_work_must_be_external" CHECK(type = 'asset' OR library = 'external'),
	CONSTRAINT "objects_practiced_requires_external" CHECK(status IS NULL OR status <> 'practiced' OR library = 'external'),
	CONSTRAINT "objects_status_check" CHECK(status IS NULL OR status IN ('draft', 'finished', 'published', 'practiced')),
	CONSTRAINT "objects_asset_has_no_source_note" CHECK(type = 'work' OR source_note IS NULL),
	CONSTRAINT "objects_work_requires_category" CHECK(type = 'asset' OR category_code IS NOT NULL),
	CONSTRAINT "objects_work_only_fields" CHECK(type = 'work' OR (published_at IS NULL AND practiced_at IS NULL AND practice_metrics IS NULL AND settled_asset_id IS NULL)),
	CONSTRAINT "objects_asset_only_fields" CHECK(type = 'asset' OR (source_type IS NULL AND ai_status IS NULL AND ai_score IS NULL AND ai_score_detail IS NULL AND value_level IS NULL AND value_scores IS NULL AND value_assessed_at IS NULL AND use_count = 0 AND last_used_at IS NULL AND origin_work_id IS NULL)),
	CONSTRAINT "objects_source_type_check" CHECK(source_type IS NULL OR source_type IN ('ai_extract', 'external_direct', 'practiced_work')),
	CONSTRAINT "objects_ai_status_check" CHECK(ai_status IS NULL OR ai_status IN ('unscored', 'auto_pass', 'needs_review', 'low_value', 'approved', 'rejected')),
	CONSTRAINT "objects_ai_score_check" CHECK(ai_score IS NULL OR (ai_score >= 0 AND ai_score <= 100)),
	CONSTRAINT "objects_value_level_check" CHECK(value_level IS NULL OR value_level IN ('S','A','B','C')),
	CONSTRAINT "objects_internal_asset_requires_value" CHECK(type <> 'asset' OR library <> 'internal' OR (value_level IS NOT NULL AND value_scores IS NOT NULL AND value_assessed_at IS NOT NULL)),
	CONSTRAINT "objects_use_count_check" CHECK(use_count >= 0)
);
--> statement-breakpoint

-- 2a) 原始行：内库作品整体搬到外库（作品只存在于外库），资产按 source 推断来源类型。
INSERT INTO `__new_objects` (
	`id`,`type`,`title`,`description`,`title_norm`,`description_norm`,`library`,`source`,`origin`,
	`category_code`,`priority`,`archived_at`,`library_changed_at`,`owner_sub`,`revision`,
	`created_at`,`updated_at`,`deleted_at`,`status`,`source_note`,
	`published_at`,`practiced_at`,`practice_metrics`,`settled_asset_id`,
	`source_type`,`ai_status`,`ai_score`,`ai_score_detail`,`value_level`,`value_scores`,
	`value_assessed_at`,`use_count`,`last_used_at`,`origin_work_id`
)
SELECT
	o.`id`, o.`type`, o.`title`, o.`description`, o.`title_norm`, o.`description_norm`,
	CASE WHEN o.`type` = 'work' THEN 'external' ELSE o.`library` END,
	o.`source`, o.`origin`, o.`category_code`, o.`priority`, o.`archived_at`,
	CASE WHEN o.`type` = 'work' AND o.`library` = 'internal'
	     THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE o.`library_changed_at` END,
	o.`owner_sub`, o.`revision`, o.`created_at`, o.`updated_at`, o.`deleted_at`,
	o.`status`, o.`source_note`,
	NULL, NULL, NULL, NULL,
	CASE WHEN o.`type` = 'asset'
	     THEN CASE o.`source` WHEN 'ai_extracted' THEN 'ai_extract' ELSE 'external_direct' END
	     ELSE NULL END,
	CASE WHEN o.`type` = 'asset' THEN 'unscored' ELSE NULL END,
	NULL, NULL,
	CASE WHEN o.`type` = 'asset' AND o.`library` = 'internal' THEN 'C' ELSE NULL END,
	CASE WHEN o.`type` = 'asset' AND o.`library` = 'internal' THEN (SELECT `value_scores` FROM `_value_backfill`) ELSE NULL END,
	CASE WHEN o.`type` = 'asset' AND o.`library` = 'internal' THEN (SELECT `assessed_at` FROM `_value_backfill`) ELSE NULL END,
	0, NULL, NULL
FROM `objects` o;
--> statement-breakpoint

-- 2b) 存量内库作品 → 内库资产（source_type = practiced_work，origin_work_id 指回原作品）。
INSERT INTO `__new_objects` (
	`id`,`type`,`title`,`description`,`title_norm`,`description_norm`,`library`,`source`,`origin`,
	`category_code`,`priority`,`archived_at`,`library_changed_at`,`owner_sub`,`revision`,
	`created_at`,`updated_at`,`deleted_at`,`status`,`source_note`,
	`published_at`,`practiced_at`,`practice_metrics`,`settled_asset_id`,
	`source_type`,`ai_status`,`ai_score`,`ai_score_detail`,`value_level`,`value_scores`,
	`value_assessed_at`,`use_count`,`last_used_at`,`origin_work_id`
)
SELECT
	t.`asset_id`, 'asset', t.`title`, t.`description`, t.`title_norm`, t.`description_norm`,
	'internal', t.`source`, t.`origin`, t.`category_code`, t.`priority`, NULL,
	strftime('%Y-%m-%dT%H:%M:%fZ','now'), t.`owner_sub`, 1,
	t.`created_at`, strftime('%Y-%m-%dT%H:%M:%fZ','now'), t.`deleted_at`,
	NULL, NULL,
	NULL, NULL, NULL, NULL,
	'practiced_work', 'unscored', NULL, NULL,
	'C', (SELECT `value_scores` FROM `_value_backfill`), (SELECT `assessed_at` FROM `_value_backfill`),
	0, NULL, t.`id`
FROM `_settled_work` t;
--> statement-breakpoint

-- 2c) 标签随资产走：原作品的标签复制到新资产上。
INSERT OR IGNORE INTO `object_tags` (`object_id`, `tag_id`)
SELECT t.`asset_id`, ot.`tag_id`
FROM `object_tags` ot
JOIN `_settled_work` t ON t.`id` = ot.`object_id`;
--> statement-breakpoint

-- 2d) 原作品回指结算出的资产；status=practiced 的推定 practiced_at = updated_at
--     （历史行没有更精确的时间来源，用它比留空更利于排序，不参与任何业务判定）。
--     不写 archived_at：practiced 作品要继续出现在默认列表与检索里。
UPDATE `__new_objects`
SET `settled_asset_id` = (SELECT t.`asset_id` FROM `_settled_work` t WHERE t.`id` = `__new_objects`.`id`),
    `practiced_at` = CASE WHEN `status` = 'practiced'
                          THEN coalesce(`practiced_at`, `updated_at`) ELSE `practiced_at` END
WHERE `id` IN (SELECT `id` FROM `_settled_work`);
--> statement-breakpoint

-- 2e) 跨库迁移审计：内库作品被搬到外库这一事实要留痕（library_events 要求跨库）。
INSERT INTO `library_events` (`id`, `object_id`, `from_library`, `to_library`, `reason`, `actor_sub`, `created_at`)
SELECT '01' || upper(hex(randomblob(12))), t.`id`, 'internal', 'external',
       '迁移 0010：内库作品沉淀为内库资产，原作品回到外库并保留 practiced 状态',
       t.`owner_sub`, strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `_settled_work` t;
--> statement-breakpoint

DROP TABLE `objects`;--> statement-breakpoint
ALTER TABLE `__new_objects` RENAME TO `objects`;--> statement-breakpoint

CREATE INDEX `objects_category_code_idx` ON `objects` (`category_code`);--> statement-breakpoint
CREATE INDEX `objects_owner_scope_idx` ON `objects` (`owner_sub`,`deleted_at`,`archived_at`);--> statement-breakpoint
CREATE INDEX `objects_type_status_idx` ON `objects` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `objects_library_idx` ON `objects` (`library`);--> statement-breakpoint
CREATE INDEX `objects_updated_at_idx` ON `objects` (`updated_at`);--> statement-breakpoint
CREATE INDEX `objects_ai_status_idx` ON `objects` (`type`,`ai_status`);--> statement-breakpoint
CREATE INDEX `objects_value_level_idx` ON `objects` (`type`,`value_level`);--> statement-breakpoint
CREATE UNIQUE INDEX `objects_origin_work_uq` ON `objects` (`origin_work_id`) WHERE `origin_work_id` IS NOT NULL AND `source_type` = 'practiced_work';--> statement-breakpoint

DROP TABLE `_settled_work`;--> statement-breakpoint
DROP TABLE `_value_backfill`;
