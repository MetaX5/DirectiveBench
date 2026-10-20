---
title: Never probe for a free name with one query per candidate inside a write transaction
date: 2026-10-20
tags: [database, performance, sqlite]
source: .ai/runs/2026-10-20-pr-44-slug-allocation.md
---

# Never probe for a free name with one query per candidate inside a write transaction

## Context

`freeSlug` found SPEC-101 rule 4's first free slug by querying `base`, `base-2`, `base-3`, … one
at a time. Each new artifact restarted at `base`, so N same-named new artifacts in one scan cost
N(N+1)/2 queries (4,501,500 for 3,000) while `applyRepositoryScan` held `BEGIN IMMEDIATE`. A real
scan of 2,000 skills that all have `name: review` took 34 s, far past the 5 s busy timeout that
other writers wait. Every test used a handful of artifacts, so the loop looked free. The final
Codex review of PR #44 found it.

Discovery names a nested `AGENTS.md` (or `CLAUDE.md`) by its path. The same-name case comes from
skills that share a frontmatter `name`, or from rules that share a basename, across many packages.

## Lesson

A loop that probes one candidate per query costs nothing on small fixtures and is quadratic on a
batch. Inside a write transaction that cost turns into lock time for every other writer. While
the transaction holds the write lock, nobody else can take a name, so one read per base plus
in-memory allocation is exact.

## How to apply

- Allocate names for a batch from memory: read the occupied names once per base, then allocate
  from a set shared by all bases, with a per-base cursor (`slugAllocator` in
  `packages/database/src/repositories/artifacts.ts`). Share the set across bases, because base
  `x-3` can take a slug that base `x` would also reach.
- For a prefix match, use a range under BINARY collation (`>= 'x-' AND < 'x.'`), not `LIKE`. Then
  `%`, `_` and `\` need no escaping, case is not folded, and the unique index serves the scan.
- Add a test with thousands of same-named items that counts statements through
  `vi.spyOn(handle.sqlite, 'prepare')`. Don't assert on wall time.
