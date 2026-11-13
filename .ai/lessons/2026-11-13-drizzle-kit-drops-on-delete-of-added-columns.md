---
title: drizzle-kit drops the ON DELETE action of a column added with ALTER TABLE
date: 2026-11-13
tags: [database, migrations, drizzle]
source: .ai/runs/2026-11-13-spec-126-phase-1.md
---

# drizzle-kit drops the ON DELETE action of a column added with ALTER TABLE

## Context

SPEC-126 Phase 1 added `artifact_versions.parent_version_id`, declared in `schema.ts` with
`.references(() => artifactVersions.id, { onDelete: 'set null' })`. `drizzle-kit generate`
(0.31) wrote `ALTER TABLE ... ADD parent_version_id text REFERENCES artifact_versions(id);`
without `ON DELETE SET NULL`, while the snapshot recorded the action. Nothing failed at
generation time; the schema test in `packages/database/test/client.test.ts` ("declares the same
foreign keys and indexes as the migrated database") compares each declared foreign key's
`onDelete` with `pragma foreign_key_list` and would have caught the mismatch.

## Lesson

A generated `ALTER TABLE ... ADD ... REFERENCES` migration does not carry the foreign key's
`ON DELETE` action. SQLite cannot change a column's foreign key later without rebuilding the
table, so a shipped migration with the wrong action is expensive to repair.

## How to apply

- After `pnpm --filter @directivebench/database exec drizzle-kit generate`, read every
  `ALTER TABLE ... ADD ... REFERENCES` line and add the action by hand (`ON DELETE SET NULL` or
  `CASCADE`), with a comment saying the file is hand-edited, as `0005` and `0006` do.
- Keep the schema test that compares declared and actual foreign keys green, and assert the
  action itself in the migration's up/down test (delete the referenced row, check the column).
