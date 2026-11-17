-- Issue 246 (SPEC-126 FR-126-07, FR-126-11, NFR-126-02; SPEC-103 FR-103-16): `artifacts.format` is
-- a source field like `type`, the format of the version the chosen active occurrence holds, and the
-- possible-duplicate key with `name`. The DDL is drizzle-kit's; the two UPDATEs are hand-written
-- backfills (an unchanged hosted remote is never re-applied, so a later scan cannot be relied on to
-- fill the column). `updated_at` is kept: no user-visible field changes.
ALTER TABLE `artifacts` ADD `format` text;--> statement-breakpoint
-- (1) An artifact with an active occurrence: the version that occurrence holds, chosen like
-- `refreshSourceFields` and migration 0007 (highest version, then the oldest occurrence
-- `created_at`, then its id).
UPDATE `artifacts`
SET `format` = `chosen`.`format`
FROM (
  SELECT `artifact_id`, `format`
  FROM (
    SELECT
      `o`.`artifact_id` AS `artifact_id`,
      `v`.`format` AS `format`,
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
-- (2) No active occurrence: the highest version whose format's type is the artifact's (kept) type,
-- else the latest version; an artifact without a version stays null. The CASE mirrors
-- ARTIFACT_FORMAT_TYPES in @directivebench/core (pinned by the migration test for every format).
UPDATE `artifacts`
SET `format` = (
  SELECT `v`.`format`
  FROM `artifact_versions` `v`
  WHERE `v`.`artifact_id` = `artifacts`.`id`
  ORDER BY
    CASE `v`.`format`
      WHEN 'skill-md' THEN 'skill'
      WHEN 'agents-md' THEN 'instruction'
      WHEN 'claude-md' THEN 'instruction'
      WHEN 'copilot-instructions' THEN 'instruction'
      WHEN 'claude-rule' THEN 'rule'
      WHEN 'copilot-path-instructions' THEN 'rule'
      WHEN 'cursor-rule' THEN 'rule'
      WHEN 'gitlab-duo-chat-rules' THEN 'rule'
    END IS `artifacts`.`type` DESC,
    `v`.`version` DESC
  LIMIT 1
)
WHERE `format` IS NULL;--> statement-breakpoint
CREATE INDEX `artifacts_format_name_idx` ON `artifacts` (`format`,`name`);
