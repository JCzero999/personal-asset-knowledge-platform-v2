PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "library_events_to_check" CHECK(to_library in ('internal', 'external')),
	CONSTRAINT "library_events_cross_check" CHECK(from_library <> to_library)
);
--> statement-breakpoint
INSERT INTO `__new_library_events`("id", "object_id", "from_library", "to_library", "reason", "actor_sub", "created_at") SELECT "id", "object_id", "from_library", "to_library", "reason", "actor_sub", "created_at" FROM `library_events`;--> statement-breakpoint
DROP TABLE `library_events`;--> statement-breakpoint
ALTER TABLE `__new_library_events` RENAME TO `library_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `library_events_object_idx` ON `library_events` (`object_id`,`created_at`);