---
title: Seeded e2e runs must be newer than the demo run, and stacked details need a fragment
date: 2026-10-29
tags: [testing, e2e, ui]
source: .ai/runs/2026-10-29-agent-run-output-files-pages.md
---

# Seeded e2e runs must be newer than the demo run, and stacked details need a fragment

## Context

SPEC-123 Phase 3 seeded two benchmark runs into the Playwright database with a fixed
`started_at` of `2026-10-29T00:00:00Z`. `demoRunId` in `apps/web/e2e/support.ts` returns the
**oldest** run, so on the day of the run the seed was older than the `directivebench demo` run
and every test that looked up "the demo run" silently got the seeded run instead (a "foreign
agent run" check returned 200). Separately, the browser QA agent found that on a 320px screen,
where the selected file is stacked under the file list, choosing a file reloaded the page at the
top and the user saw no change.

## Lesson

- A seeded run's timestamps decide which run `demoRunId` and "first link on /results" tests
  see. A fixed date in the past can become older than the demo run.
- A list-and-detail page that stacks on narrow screens needs the link to bring the detail into
  view; a full navigation scrolls to the top.

## How to apply

- Seed e2e runs with `new Date().toISOString()` (newer than the demo run) and remove them in
  `afterAll`, so `demoRunId` keeps finding the demo and later specs see the demo first.
- For list links that open a detail stacked below the list, add a fragment (`#file`) and the
  matching `id` (with `scroll-mt-*`), and test at 320px that the detail is in the viewport after
  the click.
