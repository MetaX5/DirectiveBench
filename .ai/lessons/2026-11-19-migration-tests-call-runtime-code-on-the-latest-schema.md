---
title: A migration test that calls repository code must migrate to the latest schema first
date: 2026-11-19
tags: [database, migrations, testing]
source: .ai/runs/2026-11-19-issue-260-chosen-version-format.md
---

# A migration test that calls repository code must migrate to the latest schema first

## Context

Issue 260 added the column `artifacts.source_version_id` (migration `0011`) and made
`refreshSourceFields` read it. The `0009` migration test called `refreshSourceFields` on a
database migrated only to `0010`, so it failed with `no such column: artifacts.source_version_id`
although `0009` itself was unchanged.

## Lesson

Repository functions are compiled against the current Drizzle schema (`schema.ts`), so they only
work on a database with every migration applied. A migration test that compares a backfill with
the runtime choice breaks as soon as a later migration adds a column that runtime code reads.

## How to apply

In a migration test, check the migration's own result on the partial database, then apply
`migrateDatabase(handle, migrationsFolder)` before calling any repository function (as the `0007`,
`0009` and `0011` tests do). Never call repository code on a `partialMigrations(...)` database.
