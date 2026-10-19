DROP TABLE `transcriptions`;--> statement-breakpoint
DROP TABLE `segments`;--> statement-breakpoint
ALTER TABLE `clips` DROP COLUMN `segment_ids`;--> statement-breakpoint
DELETE FROM `baselines` WHERE `provider` <> 'reference';--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'baseline_note';
