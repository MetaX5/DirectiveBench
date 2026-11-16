-- Issue 58 (SPEC-104 FR-104-16, SPEC-105 §14): the branch the last successful hosted scan read,
-- written with last_commit_sha. Nullable, no backfill: rows scanned before this migration read as
-- unknown, and the Repositories page shows no scanned-branch hint for them.
ALTER TABLE `repositories` ADD `scanned_branch` text;
