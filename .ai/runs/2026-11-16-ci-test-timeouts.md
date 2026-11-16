---
title: Fix the SPEC-126 linear-time timeout that turned main red, and the flaky hosted-repository test
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request after the session review of 2026-11-16 (main CI red after PR #230), issues #231 and #232
status: completed
branch: fix/issues-231-232-test-timeouts
specs: [SPEC-126, SPEC-014]
---

# Run: Fix the SPEC-126 linear-time timeout and the flaky hosted-repository test

## Objective

`main` CI failed after PR #230 (run 43487933441): `identity.test.ts` "links thousands of skills in
linear time (NFR-126-04)" timed out at 60 s. Issue #231: find the cause, fix it without losing
what the test detects, and get `main` green. Issue #232: the hosted-repository moves test took
5.4 s on CI in PR #226, over vitest's 5 s default; give it a named timeout.

## Plan

1. Read the duration of NFR-126-03 and NFR-126-04 in the last CI runs.
2. Measure where the time goes: alone on two cores and in the full gate on two cores, with
   temporary probes in `test-support/linear-time.ts` (reverted).
3. Decide between a smaller size and a dedicated timeout by measuring what each size detects.
4. Named timeouts, lesson update, gate, PR.

## Decisions

- **Kept the size of 3,200 skills and gave the two scan tests their own timeout of 180 s**
  instead of the shared 60 s. The issue text said "do not just raise the timeout"; the
  measurement showed the size cannot shrink without losing the test's purpose (below). The test's
  work is fixed; its wall-clock time follows the load of the other packages that `pnpm test`
  runs at once on the 2-core runner. The shared `LINEAR_TIME_TEST_TIMEOUT_MS` stays at 60 s for
  every other test.
- **Describe-level named timeout of 30 s for the whole hosted-repository file**, through one
  `realGit` options object: every test there runs real git, and 11 of 34 scan two to five times.
  Per-test arguments would have repeated the constant 34 times.

## Work performed

1. CI evidence: NFR-126-04 took 38.1 s (main after #226), 54.1 s (PR #230 branch), 60.2 s and
   timed out (main after #230); NFR-126-03 10.9, 15.8, 16.0 s.
2. Probes, alone under `taskset -c 0,1`: NFR-126-04 7.4 s in total (building the inputs 2.1 s,
   warm-up 1.4 s, three rounds 3.8 s; one scan of 3,200 skills ~0.6 s CPU with coverage). In
   `taskset -c 0,1 pnpm test --force`: 48.1 s (building 14.0 s, warm-up 8.6 s, rounds 25.5 s);
   NFR-126-03 34.6 s. The slowdown is contention, not a slower code path.
3. Sensitivity, coverage off, ratio of `expectLinearTime` (bound 3.5):

   | Size | Linear (current code) | In-memory O(n²) lookup injected | Table scan per new path injected |
   | --- | --- | --- | --- |
   | 3,200 | 1.01 | 1.89 | **4.41 (fails)** |
   | 1,600 | 0.78 | 1.08 | 1.62 (passes) |
   | 960 | 1.16 | 1.03 | 1.38 (passes) |

   Both injections were temporary edits of `packages/database/src/repositories/artifacts.ts`,
   restored from a copy afterwards (`git diff` clean for that file).
4. `identity.test.ts`: `SCAN_LINEAR_TIME_TEST_TIMEOUT_MS = 180_000` for NFR-126-03 and NFR-126-04.
5. `hosted-repository.test.ts`: `REAL_GIT_TEST_TIMEOUT_MS = 30_000` on all five `describe` blocks.
6. Lesson 2026-10-21 "Timing tests must survive a loaded CI runner" updated, index line too.

## Verification

| Command | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `taskset -c 0,1 pnpm test --force` (the whole gate, 100% coverage, on two cores) | 7/7 tasks pass in 4 min 0 s; NFR-126-04 49.7 s, NFR-126-03 34.7 s (now under 180 s), hosted moves test 0.9 s |
| CI on the PR head | see the PR |

Red first: the failure is CI run 43487933441 (`Test timed out in 60000ms`). It was not
reproduced locally as a timeout (the local two-core gate took 48 to 50 s, under 60 s), only as the
same contention pattern. The flaky hosted test was not reproduced locally (0.9 to 1.2 s under
load); the fix rests on the CI duration in PR #226.

Not verified: that 180 s holds on a future, more loaded runner; the margin is 3× the worst CI
run seen.

## Problems and deviations

- The approach in issue #231 ("do not just raise the timeout") was revised by measurement; see
  Decisions.

## Lessons recorded

- Updated [lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md](../lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md).

## Follow-ups

- Optional: lower the contention of the unit job (for example Turbo `--concurrency` in CI) if
  more heavy tests appear; not done here because it slows the whole job.
- Known limit, unchanged by this PR: the ratio tests do not catch a cheap in-memory quadratic
  lookup at these sizes (1.9 at 3,200), and a table scan per path only by a small margin (4.4
  against 3.5).
