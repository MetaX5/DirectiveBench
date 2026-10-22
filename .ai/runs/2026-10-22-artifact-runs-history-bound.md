---
title: Bound the artifact run history and group runs linearly (Codex review of PR #112)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: coordinator — Codex adversarial review of PR #112 (merged), MEDIUM finding
status: completed
branch: fix/artifact-runs-history-bound
specs: [SPEC-118, SPEC-111]
---

# Run: Bound the artifact run history (Codex round on PR #112)

## Objective

The Codex finding (MEDIUM, valid): `listArtifactRuns` loaded every run of an artifact with its
full summary JSON. The page rendered all of them, and grouping searched `block.groups` once per
run, which is quadratic: 20 000 distinct-key runs took 2.1 s before any database, JSON or render
cost. PR #112 was already merged, so the fix goes on a new branch from `main` (AGENTS.md §4).

## Decisions

- **Linear grouping:** each version keeps a `Map` from comparability key to its group.
- **Bounded page window:** `ARTIFACT_RUNS_PAGE_LIMIT` = 200 runs, newest version first.
  - The projection is lean: only the run columns and the summary fields the page renders. SQLite
    builds the summary subset with `json_object`, so traces, cases and reasons are never loaded.
  - `countArtifactRuns` counts all runs, so the page can say "Showing the latest N of M runs".
- **Regressions independent of the window.** Of the two options offered, I chose the separate
  bounded query: `listVersionComparisonRuns` returns, per (version, comparability key), the latest
  eligible run, selected with a `row_number()` window function.
  - Eligible means FR-111-50: completed, keyed, verdict not `error`/`not-comparable`, with a
    candidate aggregate and `minDelta`.
  - It is bounded by `ARTIFACT_VERSION_COMPARISON_LIMIT` = 1 000 pairs, newest version first, with
    a notice when truncated. Truncating by version leaves a contiguous newest set per key, so
    comparisons are only ever missing for the oldest versions, never wrong.
  - Why: it costs one query of at most 1 000 small rows. Computing regressions only within the
    window would hide or flip highlighting depending on how many newer runs exist.
- **Version headers** use every representative, also those outside the page window.

## Work performed

1. Database: lean `listArtifactRuns`, `countArtifactRuns` and `listVersionComparisonRuns`, with
   tests: the 205-run bound, the projection keys and values, eligibility and ranking outside the
   page window, and the bound of 1 001 pairs.
2. Web: `versionComparisons` and `resultsByVersion(versions, items, representatives)` with
   map-based grouping; `historyNotices`; nullish summary schema for the lean summary; tests,
   including a linear-time ratio test (2 000 vs 20 000 keys, bound 40×; quadratic is ~100×).
3. Page: loads the three queries in parallel and shows the notices.
4. E2E: 200 newer runs push the seeded runs out of the window. The test checks the notice, the
   200 rows, and that v2 is still flagged as a regression. Cleanup is by explicit ids.
5. SPEC-118 §20: the bound and the decision.

## Verification

- `pnpm format:check`, `lint`, `typecheck`, `test` (100% coverage in every package; database 137
  tests, web 206), `build`, `verify:pack`: pass. `pnpm test:e2e` (port 4496): 44/44.
- The linear-time test passed 3/3 under `taskset -c 0,1` with two `yes` load processes
  (lesson 2026-10-21).
- The first `pnpm test` failed on database branch coverage: the `count(*)` row fallback was
  unreachable. I removed it.

## Problems and deviations

None beyond the coverage fix above.

## Lessons recorded

None new.

## Follow-ups

- Paging through older runs (a "show older" link) if real histories need it.
