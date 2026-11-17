---
title: Run migration SQL on the SQLite of the oldest supported Node, not only on CI's
date: 2026-11-17
tags: [database, migrations, sqlite, node]
source: .ai/runs/2026-11-17-issue-246-duplicates-by-chosen-format.md
---

# Run migration SQL on the SQLite of the oldest supported Node, not only on CI's

## Context

Migration `0009` (issue 246) first backfilled with a correlated subquery whose `ORDER BY`
referenced the outer row (`... END IS artifacts.type DESC`). Every test passed locally and in CI,
which both run Node 24 (`node:sqlite` 3.53.4). The Codex adversarial review flagged it: on Node
22.23 (SQLite 3.51.3), 22.22 (3.46.1) and Node 24.3 (3.50.1) the statement fails with `no such
column: artifacts.type`, so every database test failed and an upgrade would have refused to start
on the supported minimum `engines.node >= 22.16.0` (SQLite 3.49.1).

## Lesson

`node:sqlite` bundles its own SQLite, so the SQL dialect accepted depends on the Node version. CI
tests only the `.nvmrc` version. Newer SQLite accepts constructs that older versions reject, such
as an outer column in a correlated subquery's `ORDER BY`.

## How to apply

- Reference outer rows only in `WHERE` clauses of correlated subqueries. Use `coalesce` of
  filtered subqueries or a window over a join instead of an outer reference in `ORDER BY`.
- Before pushing a migration with hand-written SQL, run the database tests on an older Node
  22 as well, for example
  `PATH=$HOME/.nvm/versions/node/v22.*/bin:$PATH node ../../node_modules/vitest/vitest.mjs run test/client.test.ts`
  in `packages/database`, and check `process.versions.sqlite`.
