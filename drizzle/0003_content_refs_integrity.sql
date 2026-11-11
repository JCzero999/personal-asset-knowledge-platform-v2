PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_content_refs` (
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
	CONSTRAINT "content_refs_dataset_id_check" CHECK(length(dataset_id) > 0),
	CONSTRAINT "content_refs_document_id_check" CHECK(length(document_id) > 0),
	CONSTRAINT "content_refs_content_key_check" CHECK(length(content_key) > 0),
	CONSTRAINT "content_refs_parse_status_check" CHECK(parse_status in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "content_refs_sync_state_check" CHECK(sync_state in ('pending', 'synced', 'sync_failed', 'deleted'))
);
--> statement-breakpoint
INSERT INTO `__new_content_refs`("id", "owner_type", "owner_id", "provider", "dataset_id", "document_id", "content_key", "role", "document_name", "content_hash", "mime", "size_bytes", "parse_status", "parse_error", "sync_state", "last_synced_at", "created_at", "updated_at", "deleted_at") SELECT "id", "owner_type", "owner_id", "provider", "dataset_id", "document_id", "content_key", "role", "document_name", "content_hash", "mime", "size_bytes", "parse_status", "parse_error", "sync_state", "last_synced_at", "created_at", "updated_at", "deleted_at" FROM `content_refs`;--> statement-breakpoint
DROP TABLE `content_refs`;--> statement-breakpoint
ALTER TABLE `__new_content_refs` RENAME TO `content_refs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `content_refs_dataset_document_uq` ON `content_refs` (`dataset_id`,`document_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_refs_dataset_content_key_uq` ON `content_refs` (`dataset_id`,`content_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_refs_primary_owner_uq` ON `content_refs` (`owner_type`,`owner_id`) WHERE role = 'primary' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `content_refs_owner_idx` ON `content_refs` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `__new_library_events` (
	`id` text PRIMARY KEY NOT NULL,
	`object_id` text NOT NULL,
	`from_library` text NOT NULL,
	`to_library` text NOT NULL,
	`reason` text NOT NULL,
	`actor_sub` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "library_events_from_check" CHECK(from_library in ('internal', 'external')),
	CONSTRAINT "library_events_to_check" CHECK(to_library in ('internal', 'external'))
);
--> statement-breakpoint
INSERT INTO `__new_library_events`("id", "object_id", "from_library", "to_library", "reason", "actor_sub", "created_at") SELECT "id", "object_id", "from_library", "to_library", "reason", "actor_sub", "created_at" FROM `library_events`;--> statement-breakpoint
DROP TABLE `library_events`;--> statement-breakpoint
ALTER TABLE `__new_library_events` RENAME TO `library_events`;--> statement-breakpoint
CREATE INDEX `library_events_object_idx` ON `library_events` (`object_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_sync_jobs` (
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
	FOREIGN KEY (`content_ref_id`) REFERENCES `content_refs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sync_jobs_action_check" CHECK(action in ('upsert', 'delete')),
	CONSTRAINT "sync_jobs_state_check" CHECK(state in ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_sync_jobs`("id", "owner_type", "owner_id", "content_ref_id", "action", "state", "attempts", "last_error", "available_at", "created_at", "updated_at") SELECT "id", "owner_type", "owner_id", "content_ref_id", "action", "state", "attempts", "last_error", "available_at", "created_at", "updated_at" FROM `sync_jobs`;--> statement-breakpoint
DROP TABLE `sync_jobs`;--> statement-breakpoint
ALTER TABLE `__new_sync_jobs` RENAME TO `sync_jobs`;--> statement-breakpoint
CREATE UNIQUE INDEX `sync_jobs_active_uq` ON `sync_jobs` (`owner_type`,`owner_id`,coalesce(`content_ref_id`, ''),`action`) WHERE state in ('pending', 'running');--> statement-breakpoint
CREATE INDEX `sync_jobs_state_idx` ON `sync_jobs` (`state`,`available_at`);