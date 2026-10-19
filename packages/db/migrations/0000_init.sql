CREATE TABLE `baselines` (
	`provider` text NOT NULL,
	`lang` text NOT NULL,
	`wer` real NOT NULL,
	PRIMARY KEY(`provider`, `lang`)
);
--> statement-breakpoint
CREATE TABLE `clips` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text,
	`lang` text NOT NULL,
	`kind` text NOT NULL,
	`start` real,
	`end` real,
	`seconds` real NOT NULL,
	`path_16k` text NOT NULL,
	`path_48k` text,
	`text` text NOT NULL,
	`native_text` text,
	`unsure` integer DEFAULT false NOT NULL,
	`split` text NOT NULL,
	`segment_ids` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `clips_lang_split` ON `clips` (`lang`,`split`);--> statement-breakpoint
CREATE TABLE `evals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text,
	`model_id` text,
	`step` integer,
	`beams` integer DEFAULT 1 NOT NULL,
	`score` real NOT NULL,
	`scores` text NOT NULL,
	`rows` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evals_run` ON `evals` (`run_id`,`step`);--> statement-breakpoint
CREATE TABLE `languages` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`script` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`path` text NOT NULL,
	`score` text,
	`active` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`lang` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`lines` text NOT NULL,
	`native_lines` text,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `prompts_lang` ON `prompts` (`lang`,`kind`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_id` text,
	`lang` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`sample_rate` integer NOT NULL,
	`seconds` real NOT NULL,
	`marks` text NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `run_steps` (
	`run_id` text NOT NULL,
	`step` integer NOT NULL,
	`epoch` real,
	`loss` real,
	`lr` real,
	PRIMARY KEY(`run_id`, `step`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base` text NOT NULL,
	`cfg` text NOT NULL,
	`status` text NOT NULL,
	`stage` text,
	`gpu` text,
	`cost_usd` real,
	`remote_id` text,
	`best_step` integer,
	`best_score` real,
	`log_path` text,
	`notes` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`start` real NOT NULL,
	`end` real NOT NULL,
	`path` text,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `synth_clips` (
	`id` text PRIMARY KEY NOT NULL,
	`lang` text NOT NULL,
	`engine` text NOT NULL,
	`prompt_id` text,
	`target` text NOT NULL,
	`gen_text` text NOT NULL,
	`style` text,
	`ref_clip_id` text,
	`ref_path` text,
	`ref_text` text,
	`params` text,
	`dur` real,
	`score` real,
	`score_native` real,
	`cps` real,
	`hyp` text,
	`path_16k` text,
	`path_raw` text,
	`run_id` text,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ref_clip_id`) REFERENCES `clips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `synth_lang_engine` ON `synth_clips` (`lang`,`engine`);--> statement-breakpoint
CREATE TABLE `transcriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`segment_id` text NOT NULL,
	`provider` text NOT NULL,
	`verbatim` text NOT NULL,
	`roman` text,
	FOREIGN KEY (`segment_id`) REFERENCES `segments`(`id`) ON UPDATE no action ON DELETE no action
);
