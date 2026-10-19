CREATE TABLE `dictations` (
	`id` text PRIMARY KEY NOT NULL,
	`audio` text,
	`sample_rate` integer NOT NULL,
	`seconds` real NOT NULL,
	`lang` text,
	`raw` text DEFAULT '' NOT NULL,
	`clean` text,
	`style` text,
	`corrected` text,
	`model_id` text,
	`app` text,
	`app_name` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text,
	`clip_id` text,
	`elapsed` real,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dictations_created` ON `dictations` (`created_at`);