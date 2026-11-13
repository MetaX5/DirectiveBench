-- Hand-edited (SPEC-126 §8.1): drizzle-kit drops the ON DELETE action of a column added with
-- ALTER TABLE, so `ON DELETE SET NULL` is written here as the schema declares it. The column is
-- nullable with no default: rows stored before this migration keep a null parent (FR-126-19).
ALTER TABLE `artifact_versions` ADD `parent_version_id` text REFERENCES artifact_versions(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `artifact_versions_content_hash_idx` ON `artifact_versions` (`content_hash`);--> statement-breakpoint
CREATE INDEX `artifact_occurrences_artifact_idx` ON `artifact_occurrences` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `artifacts_type_name_idx` ON `artifacts` (`type`,`name`);
