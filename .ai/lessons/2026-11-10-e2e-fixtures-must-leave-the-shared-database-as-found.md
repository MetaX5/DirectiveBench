---
title: An e2e spec that registers a repository must remove it, its artifacts and its jobs again
date: 2026-11-10
tags: [testing, e2e, playwright]
source: .ai/runs/2026-11-10-category-bulk.md
---

# An e2e spec that registers a repository must remove it, its artifacts and its jobs again

## Context

SPEC-124 Phase 4 added Playwright tests in `categories.spec.ts` that register and scan their own
fixture repository through the UI, so the bulk row acts on a list no other spec file touches.
`categories.spec.ts` passed alone, but the full `pnpm test:e2e` failed in two other files:
`home.spec.ts` asserts the dashboard shows exactly the demo's one artifact, and
`management.spec.ts` compares the number of completed jobs in the database with the jobs the
Executions page lists. All spec files share one server and one SQLite database and run serially
in alphabetical order, so `registry.spec.ts` (which also registers repositories) was safe only
because it runs after both.

## Lesson

Seeded rows in the shared e2e database are visible to every later spec file. Assertions on
absolute counts (one demo artifact, completed jobs) break when an earlier file leaves rows behind,
and the failure shows up far from its cause.

## How to apply

- A spec file that creates repositories, artifacts or jobs removes them in `afterAll` (or
  `afterEach`): delete the artifacts whose occurrences are in the fixture repository, then the
  repository, then the jobs that did not exist before (snapshot their ids in `beforeAll`).
- Run the full `pnpm test:e2e`, not only the changed spec file, before calling e2e green.
