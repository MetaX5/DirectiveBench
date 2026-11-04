---
title: Results pages load only the agent runs they show (issue #169)
date: 2026-11-04
agent: Claude Code / claude-opus-5-5 (om-auto-fix-issue)
trigger: maintainer request, GitHub issue #169
status: in-progress
branch: fix/issue-169-results-pages-load-needed-traces
specs: [SPEC-123]
---

# Run: Results pages load only the agent runs they show (issue #169)

## Objective

Stop the files, compare and blind-review pages from calling `getBenchmarkRunDetail`, which reads
every agent run's trace and every assertion result of the run. Acceptance criteria (issue #169):
the three pages no longer call it; repository tests cover the new reads with 100% coverage; the
e2e `agent-run-files`, `compare-files`, `blind-review` and `real-capture` stay green, including
the blind-review blindness checks.

## Plan

1. Spec first: list the new repository functions in SPEC-123 §8.3.
2. `packages/database/src/repositories/runs.ts`: `getBenchmarkRunHeader` (the existing header
   select, reused by `getBenchmarkRunDetail`), `getAgentRunSummary` (one agent run scoped by its
   benchmark run, no trace), `listAgentRunSummaries` (all agent runs, no trace, same order).
3. Switch the three pages; the run page keeps `getBenchmarkRunDetail` (it renders traces).
4. Repository tests, gate, build, verify:pack, e2e.

## Decisions

- The compare page reads every agent run of the run, but without traces or assertions
  (`listAgentRunSummaries`), not only the pair: its selects list every agent run of the case and
  its default case is the first case of the run, so a pair-only read would need a second query
  for the defaults. The rows left are small (ids, statuses, changed-file paths).
- `getBenchmarkRunDetail` keeps its shape and is built from `getBenchmarkRunHeader`, so the run
  page and every runner test stay unchanged. The run page still loads traces (it renders them).
- Agent-run reads are scoped by the benchmark run in the same `WHERE` (lesson
  2026-10-30-scope-child-writes-by-the-posted-parent), so the files page's not-found for an
  agent run of another run (FR-123-21) holds.
- No ADR: a read-path refactor inside SPEC-123's repository contract; §8.3 lists the new
  functions.

## Work performed

1. Triage (`om-verify-in-repo`): the three pages still called `getBenchmarkRunDetail` on
   `origin/main` aa0377c; no PR or commit referenced the issue.
2. SPEC-123 §8.3: `getBenchmarkRunHeader`, `getAgentRunSummary`, `listAgentRunSummaries` and
   which page reads what.
3. `packages/database/src/repositories/runs.ts`: the three functions (summaries select every
   column but `trace`); `getBenchmarkRunDetail` reuses the header and one shared order.
4. Pages: files page reads header + one agent-run summary in parallel; compare reads header +
   summaries; blind review reads the header only.
5. `packages/database/test/runs.test.ts`: header equals the detail's header; summaries equal the
   detail's agent runs minus trace and assertions, same order; no `trace` key; an agent run of
   another run, an unknown agent run and an unknown run give null or `[]`.

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test` | pass, 100% coverage everywhere (database 188, web 477 tests) |
| `pnpm build && pnpm verify:pack` | pass ("Packaging verification passed") |
| `TMPDIR=/var/tmp/… pnpm test:e2e` | 109 passed (agent-run-files 13, compare-files 14, blind-review 12, real-capture 4) |
| Red first: summaries selecting `trace` | the new repository test fails (1 failed, 21 passed) |

Performance probe (throwaway vitest file, not committed; 100 agent runs with ~200 KB traces
each, mean of 10 reads): `getBenchmarkRunDetail` 76.6 ms; files page reads 0.65 ms; compare
reads 6.2 ms; blind-review header 0.50 ms.

Not verified: no exploratory browser QA, since nothing visible changed (same data, same markup);
the e2e suite is the evidence. No measurement on a real user database.

## Problems and deviations

- `#169` in a comment in `apps/web/app` failed the design-token hex-colour test (known lesson
  2026-10-29-truncated-cells-keep-their-max-width); the web comments say "issue 169".
- The first e2e run used `TMPDIR` under `.ai/tmp/` (inside the git work tree): 15 unrelated
  tests failed (repositories "outside any work tree", real-capture workspaces below
  `CLAUDE.md`). A second run under `~/.cache` was stopped before it finished, because the lesson
  already says `$HOME` fails. With `TMPDIR=/var/tmp/<name>` all 109 passed. Lesson updated.

## Lessons recorded

- Updated [lessons/2026-10-30-keep-heavy-data-off-tmp.md](../lessons/2026-10-30-keep-heavy-data-off-tmp.md):
  `TMPDIR` must also lie outside every git work tree.

## Follow-ups

- None required. The run page still loads every trace by design.
