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

`node:sqlite` bundles its own SQLite, so the SQL dialect accepted depends on the Node version.
Newer SQLite accepts constructs that older versions reject, such as an outer column in a
correlated subquery's `ORDER BY`. CI tested only the `.nvmrc` version (Node 24) until issue 263
added the `oldest-node` job (`.github/workflows/ci.yml`), which runs the `packages/*` tests,
`pnpm build` and `pnpm verify:pack` on Node 22.16.0 (SQLite 3.49.1) and prints both versions.

The binding differs too, not only the SQL dialect: on Node 22 (22.16 and 22.23) `node:sqlite`
returns a TEXT value only up to its first NUL character, while Node 24.21 returns all of it
(issue 265).

## How to apply

- Reference outer rows only in `WHERE` clauses of correlated subqueries. Use `coalesce` of
  filtered subqueries or a window over a join instead of an outer reference in `ORDER BY`.
- The CI job `oldest-node` must pass. Before pushing a migration with hand-written SQL, also run
  the database tests on Node 22.16 locally, for example
  `PATH=$HOME/.nvm/versions/node/v22.*/bin:$PATH node ../../node_modules/vitest/vitest.mjs run test/client.test.ts`
  in `packages/database`, and check `process.versions.sqlite`. Without a local Node 22.16,
  download the official tarball into `/var/tmp` (not `/tmp`), check it against `SHASUMS256.txt`
  and remove it afterwards. Turn coverage off there (`--coverage.enabled=false`): the threshold
  belongs to the Node 24 jobs.
