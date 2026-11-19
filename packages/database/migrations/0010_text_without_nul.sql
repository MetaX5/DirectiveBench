-- Hand-written data-only migration (issue 265, SPEC-006 §1): stored text never holds U+0000.
-- node:sqlite on Node 22 returns a TEXT value only up to its first NUL, so a value an earlier
-- version stored with one reads back truncated. Each free-text column below gets U+FFFD for every
-- U+0000 (the replacement error and message columns now get on write); only rows holding a NUL
-- are written and `updated_at` is kept. JSON columns never hold a raw NUL (JSON escapes it); ids,
-- enums, timestamps, hashes, slugs and paths are never taken from text that can.
-- SQLite's replace() and text substr() stop at a NUL, so each value is rewritten as a BLOB (byte
-- offsets; U+0000 is the only UTF-8 sequence holding the byte 00), one NUL per recursion step.
-- Active category name keys are unique (`categories_active_name_key_unique`), and U+FFFD is not
-- injective: `x\0y` may meet a clean `x\uFFFDy`, and `x\0\uFFFDy` meets `x\uFFFD\0y`. So every
-- active category with a NUL in its key keeps its id, slug and assignments and gets ` (<id>)` after
-- its name and ` (<lowercased id>)` after its key (still `categoryNameKey(name)`, ids are ASCII).
-- Two such keys never meet: an id holds no ` (`, so equal keys would need equal ids. One that
-- meets a clean active key (a category deliberately named after another one's id) is archived,
-- which the partial index allows. Archived categories only get the repair. The name itself is
-- repaired by the next statement.
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`name_key` AS BLOB) FROM `categories` WHERE instr(CAST(`name_key` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `categories` SET
  `name_key` = CASE WHEN `categories`.`archived_at` IS NULL THEN CAST(`fix`.`v` AS TEXT) || ' (' || lower(`categories`.`id`) || ')' ELSE CAST(`fix`.`v` AS TEXT) END,
  `name` = CASE WHEN `categories`.`archived_at` IS NULL THEN `categories`.`name` || ' (' || `categories`.`id` || ')' ELSE `categories`.`name` END,
  `archived_at` = CASE WHEN `categories`.`archived_at` IS NULL AND EXISTS (
    SELECT 1 FROM `categories` AS `clash`
    WHERE `clash`.`archived_at` IS NULL AND `clash`.`id` <> `categories`.`id` AND `clash`.`name_key` = CAST(`fix`.`v` AS TEXT) || ' (' || lower(`categories`.`id`) || ')'
  ) THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE `categories`.`archived_at` END
FROM `fix` WHERE `fix`.`id` = `categories`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`name` AS BLOB) FROM `categories` WHERE instr(CAST(`name` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `categories` SET `name` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `categories`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`description` AS BLOB) FROM `categories` WHERE instr(CAST(`description` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `categories` SET `description` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `categories`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`name` AS BLOB) FROM `repositories` WHERE instr(CAST(`name` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `repositories` SET `name` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `repositories`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`sync_error` AS BLOB) FROM `repositories` WHERE instr(CAST(`sync_error` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `repositories` SET `sync_error` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `repositories`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`name` AS BLOB) FROM `artifacts` WHERE instr(CAST(`name` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `artifacts` SET `name` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `artifacts`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`description` AS BLOB) FROM `artifacts` WHERE instr(CAST(`description` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `artifacts` SET `description` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `artifacts`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`notes` AS BLOB) FROM `artifacts` WHERE instr(CAST(`notes` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `artifacts` SET `notes` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `artifacts`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`name` AS BLOB) FROM `benchmark_suites` WHERE instr(CAST(`name` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `benchmark_suites` SET `name` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `benchmark_suites`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`description` AS BLOB) FROM `benchmark_suites` WHERE instr(CAST(`description` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `benchmark_suites` SET `description` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `benchmark_suites`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`error` AS BLOB) FROM `jobs` WHERE instr(CAST(`error` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `jobs` SET `error` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `jobs`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`agent_version` AS BLOB) FROM `benchmark_runs` WHERE instr(CAST(`agent_version` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `benchmark_runs` SET `agent_version` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `benchmark_runs`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`error` AS BLOB) FROM `benchmark_runs` WHERE instr(CAST(`error` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `benchmark_runs` SET `error` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `benchmark_runs`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`error` AS BLOB) FROM `agent_runs` WHERE instr(CAST(`error` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `agent_runs` SET `error` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `agent_runs`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`output_files_reason` AS BLOB) FROM `agent_runs` WHERE instr(CAST(`output_files_reason` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `agent_runs` SET `output_files_reason` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `agent_runs`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`message` AS BLOB) FROM `assertion_results` WHERE instr(CAST(`message` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `assertion_results` SET `message` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `assertion_results`.`id` AND instr(`fix`.`v`, x'00') = 0;
--> statement-breakpoint
WITH RECURSIVE `fix`(`id`, `v`) AS (
  SELECT `id`, CAST(`note` AS BLOB) FROM `blind_review_pairs` WHERE instr(CAST(`note` AS BLOB), x'00') > 0
  UNION ALL
  SELECT `id`, CAST(substr(`v`, 1, instr(`v`, x'00') - 1) || x'EFBFBD' || substr(`v`, instr(`v`, x'00') + 1) AS BLOB)
  FROM `fix` WHERE instr(`v`, x'00') > 0
)
UPDATE `blind_review_pairs` SET `note` = CAST(`fix`.`v` AS TEXT)
FROM `fix` WHERE `fix`.`id` = `blind_review_pairs`.`id` AND instr(`fix`.`v`, x'00') = 0;
