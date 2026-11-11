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
	`tags` text DEFAULT '[]' NOT NULL,
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
	CONSTRAINT "objects_type_check" CHECK(type in ('asset', 'work')),
	CONSTRAINT "objects_library_check" CHECK(library in ('internal', 'external')),
	CONSTRAINT "objects_priority_check" CHECK(priority in ('low', 'medium', 'high')),
	CONSTRAINT "objects_source_check" CHECK(source in ('handwritten', 'ai_extracted')),
	CONSTRAINT "objects_origin_check" CHECK(origin in ('self', 'imported')),
	CONSTRAINT "objects_status_only_for_work" CHECK(type = 'work' OR status IS NULL),
	CONSTRAINT "objects_external_not_practiced" CHECK(NOT (library = 'external' AND status = 'practiced')),
	CONSTRAINT "objects_status_check" CHECK(status IS NULL OR status IN ('draft', 'finished', 'published', 'practiced')),
	CONSTRAINT "objects_format_check" CHECK(format IS NULL OR format IN ('article', 'script', 'course', 'live', 'consult', 'flomo')),
	CONSTRAINT "objects_asset_has_no_work_fields" CHECK(type = 'work' OR (format IS NULL AND source_note IS NULL)),
	CONSTRAINT "objects_work_requires_format" CHECK(type = 'asset' OR format IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_objects`("id", "type", "title", "description", "library", "source", "origin", "primary_category", "categories", "tags", "priority", "archived_at", "library_changed_at", "owner_sub", "revision", "created_at", "updated_at", "deleted_at", "format", "status", "source_note") SELECT "id", "type", "title", "description", "library", "source", "origin", "primary_category", "categories", "tags", "priority", "archived_at", "library_changed_at", "owner_sub", "revision", "created_at", "updated_at", "deleted_at", "format", "status", "source_note" FROM `objects`;--> statement-breakpoint
DROP TABLE `objects`;--> statement-breakpoint
ALTER TABLE `__new_objects` RENAME TO `objects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `objects_type_status_idx` ON `objects` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `objects_library_idx` ON `objects` (`library`);--> statement-breakpoint
CREATE INDEX `objects_updated_at_idx` ON `objects` (`updated_at`);