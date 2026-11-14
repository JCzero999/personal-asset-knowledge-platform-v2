-- v2.1：使用事件、价值评估历史、正文快照与等级锁定（规格 v2.1 §2–§4）
--
-- 目的：
--   * 定义「一次有效调用」并留下可统计的事件流（asset_usage_events）；
--   * 所有 value_* 写入先落 append-only 历史（value_assessment_history），
--     让「为什么从 A 掉到 B」可追溯；
--   * 沉淀资产保留正文 hash + 前 2000 字快照，作品大改后资产仍有据可查；
--   * 允许手动锁定等级，自动升降级不碰锁定资产；
--   * last_level_adjust_at 支撑「24 小时内同一资产最多自动调整一次」。
--
-- 只做 ADD COLUMN，不重建 objects：现有 CHECK 已覆盖旧列，
-- 新列由服务层与回填保证取值域。

ALTER TABLE `objects` ADD COLUMN `value_level_locked` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `objects` ADD COLUMN `content_hash` text;--> statement-breakpoint
ALTER TABLE `objects` ADD COLUMN `content_snapshot` text;--> statement-breakpoint
ALTER TABLE `objects` ADD COLUMN `content_snapshot_at` text;--> statement-breakpoint
ALTER TABLE `objects` ADD COLUMN `last_level_adjust_at` text;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 使用事件：一次记录 = 一次明确动作（详情停留 / 打开原文 / 复制 / 引用）
-- ---------------------------------------------------------------------------
CREATE TABLE `asset_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` text NOT NULL,
	`actor_sub` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "asset_usage_events_kind_check" CHECK(kind in ('detail_dwell', 'open_source', 'copy', 'reference'))
);--> statement-breakpoint

CREATE INDEX `asset_usage_events_asset_time_idx` ON `asset_usage_events` (`asset_id`,`occurred_at`);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 价值评估历史：append-only，主表每次写 value_* 前先插一条
-- ---------------------------------------------------------------------------
CREATE TABLE `value_assessment_history` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`assessed_at` text NOT NULL,
	`assessed_by` text NOT NULL,
	`trigger` text NOT NULL,
	`value_level` text NOT NULL,
	`value_scores` text,
	`prev_level` text,
	`prev_scores` text,
	`reason` text,
	FOREIGN KEY (`asset_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "value_assessment_history_level_check" CHECK(value_level in ('S', 'A', 'B', 'C')),
	CONSTRAINT "value_assessment_history_prev_level_check" CHECK(prev_level is null or prev_level in ('S', 'A', 'B', 'C')),
	CONSTRAINT "value_assessment_history_trigger_check" CHECK("trigger" in ('create', 'settle', 'review', 'manual_reassess', 'auto_upgrade', 'auto_downgrade', 'migration'))
);--> statement-breakpoint

CREATE INDEX `value_assessment_history_asset_time_idx` ON `value_assessment_history` (`asset_id`,`assessed_at` DESC);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 回填：每个存量内库资产补一条初始评估（trigger = migration）
-- 时间取原 value_assessed_at；历史行没有 prev_*，因为迁移前没有可追溯的旧值。
-- ---------------------------------------------------------------------------
INSERT INTO `value_assessment_history` (
	`id`, `asset_id`, `assessed_at`, `assessed_by`, `trigger`,
	`value_level`, `value_scores`, `prev_level`, `prev_scores`, `reason`
)
SELECT
	'01' || upper(hex(randomblob(12))),
	o.`id`,
	coalesce(o.`value_assessed_at`, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
	'migration',
	'migration',
	o.`value_level`,
	o.`value_scores`,
	NULL,
	NULL,
	'迁移 0011：存量内库资产初始评估'
FROM `objects` o
WHERE o.`type` = 'asset'
  AND o.`library` = 'internal'
  AND o.`value_level` IS NOT NULL;
