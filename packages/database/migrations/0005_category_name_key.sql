-- Hand-edited (SPEC-124 §8.1): `DEFAULT ''` lets ALTER TABLE ADD run on a non-empty table (the
-- Drizzle schema has no default, so every typed insert sets name_key), and the UPDATE backfills
-- the key. SQLite lower() folds ASCII only, which is exact here: until this migration only the
-- ASCII predefined categories exist. From now on name_key is written from categoryNameKey().
ALTER TABLE `categories` ADD `name_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `categories` SET `name_key` = lower(trim(`name`));--> statement-breakpoint
CREATE UNIQUE INDEX `categories_active_name_key_unique` ON `categories` (`name_key`) WHERE archived_at is null;
