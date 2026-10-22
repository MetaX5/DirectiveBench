---
title: Pin each migration's up/down test to its own journal prefix, never to the full folder
date: 2026-10-22
tags: [database, migrations, testing]
source: .ai/runs/2026-10-22-ab-baseline-storage.md
---

# Pin each migration's up/down test to its own journal prefix, never to the full folder

## Context

The `0001_add_job_result` test migrated a database to the first journal entry, then "up" with the
real migrations folder, expecting `applied = 1`, and rolled back by deleting the newest
`__drizzle_migrations` row. Adding `0002_add_baseline_artifact_version` (SPEC-118 Phase 2) made
"up" apply two migrations and made the rollback forget 0002 instead of 0001 — the 0001 test
broke because of a later, unrelated migration, and its rollback step would have silently tested
the wrong migration had the counts not been asserted.

## Lesson

A migration test that targets "the latest folder" tests whatever migration happens to be last.
Each additive migration's up/down test must migrate from journal prefix `n` to prefix `n + 1`
(`partialMigrations(dir, n + 1)` in `packages/database/test/client.test.ts`); only the newest
migration's test may use the real folder. The `in-memory … applied` count in `openDatabase` tests
also changes with every migration.

## How to apply

When adding migration `000N`, update the previous newest migration's test to use
`partialMigrations(temp.dir, N)` as its target, add a test for `000N` (an existing row survives,
the column is nullable, rollback restores the previous shape and the migration re-applies), and
bump the total `applied` counts. SQLite can `DROP COLUMN` a column with a `REFERENCES` clause once
its indexes are dropped, so the rollback plan of an additive foreign-key column is
`drop index …; alter table … drop column …` plus forgetting the migration row.
