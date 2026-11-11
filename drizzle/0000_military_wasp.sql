CREATE TABLE `content_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`dataset_id` text NOT NULL,
	`document_id` text NOT NULL,
	`content_key` text NOT NULL,
	`role` text NOT NULL,
	`document_name` text,
	`content_hash` text,
	`mime` text,
	`size_bytes` integer,
	`parse_status` text DEFAULT 'pending' NOT NULL,
	`parse_error` text,
	`sync_state` text DEFAULT 'pending' NOT NULL,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "content_refs_owner_type_check" CHECK(owner_type in ('asset', 'work')),
	CONSTRAINT "content_refs_provider_check" CHECK(provider = 'ragflow'),
	CONSTRAINT "content_refs_role_check" CHECK(role in ('primary', 'attachment')),
	CONSTRAINT "content_refs_parse_status_check" CHECK(parse_status in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "content_refs_sync_state_check" CHECK(sync_state in ('pending', 'synced', 'sync_failed', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_refs_dataset_document_uq` ON `content_refs` (`dataset_id`,`document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_refs_dataset_content_key_uq` ON `content_refs` (`dataset_id`,`content_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_refs_primary_owner_uq` ON `content_refs` (`owner_type`,`owner_id`) WHERE role = 'primary' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `content_refs_owner_idx` ON `content_refs` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `library_events` (
	`id` text PRIMARY KEY NOT NULL,
	`object_id` text NOT NULL,
	`from_library` text NOT NULL,
	`to_library` text NOT NULL,
	`reason` text NOT NULL,
	`actor_sub` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "library_events_from_check" CHECK(from_library in ('internal', 'external')),
	CONSTRAINT "library_events_to_check" CHECK(to_library in ('internal', 'external'))
);
--> statement-breakpoint
CREATE INDEX `library_events_object_idx` ON `library_events` (`object_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `objects` (
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
	CONSTRAINT "objects_external_not_practiced" CHECK(NOT (library = 'external' AND status = 'practiced'))
);
--> statement-breakpoint
CREATE INDEX `objects_type_status_idx` ON `objects` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `objects_library_idx` ON `objects` (`library`);--> statement-breakpoint
CREATE INDEX `objects_updated_at_idx` ON `objects` (`updated_at`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`content_ref_id` text,
	`action` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`available_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "sync_jobs_action_check" CHECK(action in ('upsert', 'delete')),
	CONSTRAINT "sync_jobs_state_check" CHECK(state in ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `sync_jobs_state_idx` ON `sync_jobs` (`state`,`available_at`);