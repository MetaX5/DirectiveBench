---
title: Explain a no-op conditional write inside the same transaction
date: 2026-11-10
tags: [database, concurrency, sqlite]
source: .ai/runs/2026-11-05-category-assignment.md
---

# Explain a no-op conditional write inside the same transaction

## Context

`assignArtifactCategory` (SPEC-124 FR-124-11) inserts with `INSERT … SELECT … WHERE
archived_at IS NULL ON CONFLICT DO NOTHING` and, when nothing was inserted, read the category to
explain why: archived → "category-archived", otherwise "already-assigned". The Codex adversarial
review on PR 198 found that an unarchive landing between the insert and the read made the
function report "already assigned" although no assignment existed: "otherwise" was inferred, not
read.

## Lesson

A follow-up read after a no-op conditional write sees a later state than the write did, so
"otherwise" outcomes inferred from it can be false. A bounded retry only moves the problem: the
next Codex round found that the exhausted retry had to report a state the read contradicted, and
needed new copy. Put the conditional write and the reads that explain it in one
`withTransaction` (BEGIN IMMEDIATE keeps every other writer out), which AGENTS.md §7 already asks
for check-then-act on shared state.

## How to apply

- When a repository function writes conditionally and then reads to explain a no-op, run both in
  `withTransaction` and take the `DatabaseHandle`.
- Test it with `interceptHandle` (packages/database/test/support): record
  `handle.sqlite.isTransaction` for every statement and assert all are inside the transaction and
  none is left open afterwards. An interleaving injected through `interceptHandle` runs on the same
  connection, inside the transaction, so it cannot stand for another process.
