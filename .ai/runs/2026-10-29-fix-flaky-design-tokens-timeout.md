---
title: Fix the flaky design-tokens FR-121-5 timeout (#149)
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: user request, om-auto-fix-issue (brief mode, filed as #149)
status: completed
branch: fix/issue-149-flaky-design-tokens-timeout
specs: [SPEC-121]
---

# Run: Fix the flaky design-tokens FR-121-5 timeout (#149)

## Objective

Stop `apps/web/test/design-tokens.test.ts` > *appear only as documented exceptions (FR-121-5)*
from timing out at vitest's default 5000 ms on the 2-core CI runner (run 40904491342, PR #145).
Acceptance criteria from #149: a named per-test timeout, the guard still catches a new arbitrary
value, `pnpm test` at 100% and CI green.

## Plan

Bug chain: brief → `om-prepare-issue` (#149) → `om-verify-in-repo` → `om-root-cause` → `om-fix`
→ `om-open-pr` → `om-auto-review-pr`. Test-only change: a named `SOURCE_SCAN_TIMEOUT_MS`.

## Decisions

- 30 s timeout: about 6× the worst CI observation (5172 ms), well below the 60 s of
  `LINEAR_TIME_TEST_TIMEOUT_MS`.
- No parse filter for files without `[` or `(--`: only 41 of 114 files would be skipped, so it
  would save about a third of the time at the cost of an extra code path in the guard.
- Only this test gets the timeout: the other scans in the file are line regexes that ran in tens
  of milliseconds in the same CI log.

## Work performed

1. Filed #149 with CI evidence (11 runs, file duration 2.1–6.4 s).
2. Added `SOURCE_SCAN_TIMEOUT_MS` with its reason and passed it to the FR-121-5 test.
3. Extended the loaded-runner timing lesson instead of adding a near-duplicate.

## Verification

- Timing: 0.2 s unloaded; 0.41 s pinned to one idle core; 1.59 s under
  `taskset -c 0,1 pnpm test --force` (no timeout reproduced locally, CI is slower).
- Red-first (guard): a temporary `'p-[13px]'` in `components/ui/badge.stories.tsx` fails the test.
- Red-first (wiring): `SOURCE_SCAN_TIMEOUT_MS = 1` fails it with `Test timed out in 1ms.`
- Full gate: see the PR.
- Not verified: the CI timeout itself is not reproduced locally; CI on the PR decides.

## Problems and deviations

None.

## Lessons recorded

- Updated [Timing tests must survive a loaded CI runner](../lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md).

## Follow-ups

None.
