ALTER TABLE `prompts` ADD `native` text;--> statement-breakpoint
ALTER TABLE `prompts` ADD `roman` text;--> statement-breakpoint
ALTER TABLE `prompts` ADD `starter` integer;--> statement-breakpoint
ALTER TABLE `recordings` ADD `script` text;--> statement-breakpoint
UPDATE `languages` SET `script` = CASE WHEN `script` = 'Latin (romanized)' THEN 'roman' ELSE 'native' END;--> statement-breakpoint
UPDATE `prompts` SET
  `native` = CASE WHEN `lang` IN (SELECT `code` FROM `languages` WHERE `script` = 'roman') THEN `native_lines` ELSE `lines` END,
  `roman` = CASE WHEN `lang` IN (SELECT `code` FROM `languages` WHERE `script` = 'roman') THEN `lines` END;--> statement-breakpoint
UPDATE `recordings` SET `script` = CASE WHEN `lang` IN (SELECT `code` FROM `languages` WHERE `script` = 'roman') THEN 'roman' ELSE 'native' END;--> statement-breakpoint
DELETE FROM `prompts` WHERE `source` IN ('builtin', 'seed')
  AND NOT EXISTS (SELECT 1 FROM `recordings` r WHERE r.`prompt_id` = `prompts`.`id`)
  AND NOT EXISTS (SELECT 1 FROM `synth_clips` s WHERE s.`prompt_id` = `prompts`.`id`);--> statement-breakpoint
UPDATE `prompts` SET `source` = 'retired' WHERE `source` IN ('builtin', 'seed');--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'seed_version';--> statement-breakpoint
ALTER TABLE `prompts` DROP COLUMN `lines`;--> statement-breakpoint
ALTER TABLE `prompts` DROP COLUMN `native_lines`;
