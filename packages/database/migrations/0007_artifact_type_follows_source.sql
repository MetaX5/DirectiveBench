-- Hand-written data-only migration (issue 66, SPEC-103 FR-103-16, SPEC-101 §8.2): an artifact's
-- type is the type of the format of the version its chosen active occurrence holds, the same
-- choice as its name (SPEC-126 FR-126-07): the highest version number, ties broken by the oldest
-- occurrence `created_at`, then its id. Before this migration the type was frozen at creation, so
-- a format change at the same path left it stale; an unchanged hosted remote is never re-applied,
-- so a later scan cannot be relied on to repair it. Only rows whose type differs are written; an
-- artifact with no active occurrence keeps its type. The CASE mirrors ARTIFACT_FORMAT_TYPES in
-- @directivebench/core (pinned by the migration test for every format).
UPDATE `artifacts`
SET
  `type` = `chosen`.`type`,
  `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT `artifact_id`, `type`
  FROM (
    SELECT
      `o`.`artifact_id` AS `artifact_id`,
      CASE `v`.`format`
        WHEN 'skill-md' THEN 'skill'
        WHEN 'agents-md' THEN 'instruction'
        WHEN 'claude-md' THEN 'instruction'
        WHEN 'copilot-instructions' THEN 'instruction'
        WHEN 'claude-rule' THEN 'rule'
        WHEN 'copilot-path-instructions' THEN 'rule'
        WHEN 'cursor-rule' THEN 'rule'
        WHEN 'gitlab-duo-chat-rules' THEN 'rule'
      END AS `type`,
      row_number() OVER (
        PARTITION BY `o`.`artifact_id`
        ORDER BY `v`.`version` DESC, `o`.`created_at`, `o`.`id`
      ) AS `rank`
    FROM `artifact_occurrences` `o`
    INNER JOIN `artifact_versions` `v` ON `v`.`id` = `o`.`latest_version_id`
    WHERE `o`.`status` = 'active'
  )
  WHERE `rank` = 1 AND `type` IS NOT NULL
) AS `chosen`
WHERE `chosen`.`artifact_id` = `artifacts`.`id` AND `artifacts`.`type` <> `chosen`.`type`;
