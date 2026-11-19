-- Issue 260 (SPEC-126 FR-126-07, FR-126-13, §11.6 J3): `artifacts.source_version_id` is a source
-- field like `format`, the id of the version the chosen active occurrence holds, whose content the
-- Possible duplicates card compares. The DDL is drizzle-kit's; the two UPDATEs are hand-written
-- backfills with the rules of migration 0009 (an unchanged hosted remote is never re-applied, so a
-- later scan cannot be relied on to fill the column). `updated_at` is kept: nothing shown changes.
ALTER TABLE `artifacts` ADD `source_version_id` text;--> statement-breakpoint
-- (1) An artifact with an active occurrence: the version that occurrence holds, chosen like
-- `refreshSourceFields` and migration 0009 (highest version, then the oldest occurrence
-- `created_at`, then its id).
UPDATE `artifacts`
SET `source_version_id` = `chosen`.`version_id`
FROM (
  SELECT `artifact_id`, `version_id`
  FROM (
    SELECT
      `o`.`artifact_id` AS `artifact_id`,
      `v`.`id` AS `version_id`,
      row_number() OVER (
        PARTITION BY `o`.`artifact_id`
        ORDER BY `v`.`version` DESC, `o`.`created_at`, `o`.`id`
      ) AS `rank`
    FROM `artifact_occurrences` `o`
    INNER JOIN `artifact_versions` `v` ON `v`.`id` = `o`.`latest_version_id`
    WHERE `o`.`status` = 'active'
  )
  WHERE `rank` = 1
) AS `chosen`
WHERE `chosen`.`artifact_id` = `artifacts`.`id`;--> statement-breakpoint
-- (2) No active occurrence: the highest version whose format is the artifact's (kept) format, else
-- the latest version; an artifact without a version stays null. The outer row is referenced only
-- in WHERE clauses: SQLite before 3.53 rejects an outer column in a correlated subquery's ORDER BY
-- ("no such column"), and Node 22.16 bundles 3.49 (lesson 2026-11-17).
UPDATE `artifacts`
SET `source_version_id` = coalesce(
  (
    SELECT `v`.`id`
    FROM `artifact_versions` `v`
    WHERE `v`.`artifact_id` = `artifacts`.`id`
      AND `v`.`format` = `artifacts`.`format`
    ORDER BY `v`.`version` DESC
    LIMIT 1
  ),
  (
    SELECT `v`.`id`
    FROM `artifact_versions` `v`
    WHERE `v`.`artifact_id` = `artifacts`.`id`
    ORDER BY `v`.`version` DESC
    LIMIT 1
  )
)
WHERE `source_version_id` IS NULL;
