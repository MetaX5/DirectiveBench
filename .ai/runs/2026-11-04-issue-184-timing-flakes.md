---
title: Fix three timing-dependent tests of issue 184 from evidence
date: 2026-11-04
agent: Claude Code / claude-opus-5-5
trigger: issue #184 (umbrella), maintainer-approved, om-auto-fix-issue 184
status: in-progress
branch: fix/issue-184-timing-flakes
specs: [SPEC-014]
---

# Run: Fix three timing-dependent tests of issue 184 from evidence

## Objective

Issue #184 collects tests that fail now and then on a loaded machine or runner. In scope, in
order: (1) the coverage flake of `packages/agent-adapters/src/claude-code/process.ts` lines 97
and 229 (macOS unit job, PR #183), mandatory; (2) `packages/core/test/linear-time.test.ts` and
`packages/database/test/artifacts.test.ts` if the evidence allows. #177 and #75 stay open. Rules:
explain each from evidence, never just raise a timeout, no threshold, exclusion or `v8 ignore`
change, product code only for a real product bug.

## Plan

1. Read the failing logs, find which tests reach the lines and why that depends on timing.
2. Reproduce or measure under `taskset -c 0,1` with `yes` load; dump per-statement hit counts.
3. Make each fix measure something load-independent or do less work; prove it red first.
4. Gate, 10 full loaded Linux suites, a macOS probe on a throwaway branch (before and after).

## Decisions

- Tests only: no occurrence is a product bug. The guards in `process.ts` are correct, and only
  their coverage was left to chance.
- The deterministic cover is a new test file with a stub child instead of making the `flood` fake
  keep writing after SIGTERM: a fake that ignores SIGTERM still needs the writer to run within
  the grace period, so it would only shrink the race.
- The slug test does less work (500 instead of 3,000 artifacts) instead of a larger timeout: its
  regression check is a statement count, which catches a per-candidate query at any size.
- The process-clock control of `linear-time.test.ts` reads 2 to 64 MiB instead of 256 KiB to
  8 MiB; the helper and its bound are unchanged.

## Work performed

(filled in below with evidence)

### 1. `process.ts` lines 97 and 229 (coverage)

- Failing job 126793890842 (run 41892278631, PR #183, macOS): `process.ts | 98.34 | 94.44 | 100
  | 100 | 97,229`, statements and branches below 100%. Linux on the same run was green.
- Line 97 is `LineCollector.push` returning `false` once `limitExceeded` is set; line 229 is
  `terminate()` returning when `forceKillTimer` is set or `claude` exited. In the package's tests
  only `process.test.ts` "stops a run whose stdout exceeds the limit" reaches them, and only through
  stdout chunks that arrive after the over-limit chunk (SIGTERM already sent).
- Hit counts (`--coverage.reporter=json`, statement `return` on each line), that test alone:
  idle 3/3 runs and under `taskset -c 0,1` + six `yes` 20/20 runs: line 97 `return` hit 2, line 229
  `return` hit 2. The whole `process.test.ts` under the same load, 8 runs: every statement and
  branch hit count identical between runs. The whole agent-adapters package, 5 runs under load:
  100% every time, the same set of covered statements and branches. Linux's full pipe always
  holds the chunk, so Linux cannot reproduce it; on macOS the writer may not run again before
  SIGTERM arrives, and no chunk follows. Mechanism inferred from code and the macOS log, not
  reproduced on macOS locally (see the probe below).
- Fix: `packages/agent-adapters/test/claude-code/process-events.test.ts` mocks `spawn` with a
  stub child and the process-group helpers, and emits the events itself: output, an over-limit
  chunk, a late chunk, then exit and close (one SIGTERM, late output dropped); and exit followed
  by over-limit output (no signal after exit). Alone it hits line 97's `return` once and line
  229's twice.
- Red first: with `if (exited) return;` (no `forceKillTimer` check) the first test fails
  ("expected to be called 1 times, but got 2 times"); with `if (forceKillTimer) return;` the second
  fails ("expected not to be called, but called 1 times").

### 2. `linear-time.test.ts` "measures an asynchronous baseline with the process clock"

- Evidence: the PR #182 run log records the failure (ratio 0.338 against the bound
  1 / 3.5 = 0.286, loaded machine).
- Per-call process CPU of the control's `readv` (256 buffers), fastest of 4 × 20 ms, 3 runs:
  256 B 44–46 µs, 256 KiB 48–53 µs, 2 MiB 116–136 µs, 8 MiB 371–483 µs, 64 MiB 4395–4724 µs.
  The fixed ~45 µs is 90% of the small read, so the baseline grew ~8× instead of 32× and the
  ratio's margin to the bound was under 2×; anything that adds per-call cost (context switches
  under load) moves it towards the bound.
- Ratio, temporary probe (same case, 5 ratios per vitest run): idle 0.109–0.147. Under
  `taskset -c 0,1` + two `yes` + parallel vitest runs with coverage: 20 ratios 0.119–0.161. With a
  full `pnpm test --force --concurrency=4` on the same two cores as well, 30 ratios each:
  256 KiB to 8 MiB (before) 0.135–0.190; 2 to 64 MiB (after) 0.031–0.039. The 0.338 failure was
  not reproduced; the margin went from 1.5× to 7.3× at the worst sample.
- Fix: the case reads `BASELINE_LARGE = 64 MiB` (small 2 MiB). Its power to catch the bug it
  guards is unchanged: with the thread clock the baseline's test-thread work stays constant
  (256 buffers), so the ratio is ~1, far above the bound.

### 3. `artifacts.test.ts` "allocates sequential slugs to … same-named artifacts"

- Evidence: Linux unit job 126789336957 (run 41891367007, attempt 1, PR #182): timed out at
  30,000 ms (31,232 ms). The green Linux job before it (run 41890630083) took 24,704 ms for the same
  test; macOS job 126793890842 took 2,780 ms (it runs two packages at once, Linux all of them).
- Cost is linear and small: 750 / 1,500 / 3,000 / 6,000 artifacts took 292 / 462 / 853 / 1,554 ms
  idle without coverage (1,331 ms for 3,000 with coverage). Under `taskset -c 0,1` + six `yes`,
  with coverage: 3,000 took 7.6–8.6 s, 500 took 1.5–1.6 s. The Linux runner is the starved one:
  up to 30× the idle time.
- Fix: 500 artifacts instead of 3,000; the timeout stays 30 s. The test's regression check is the
  statement count (one slug query, fewer than 8 per artifact), which the old per-candidate loop
  fails at any size (about count²/2 queries). Red first: with the allocator's per-base cursor
  removed (`nextSuffix.set` commented out) the test fails "expected [ …(500) ] to have a length of
  1 but got 500".

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test --force`: passed, 7/7 test
  tasks, 100% coverage.
- (loaded loop and macOS probe results below)

## Problems and deviations

- Temporary probe test files in `packages/core/test` were picked up by one loaded full run (its
  core task failed on them); they were moved out of the work tree before the gate. Never
  committed.

## Lessons recorded

- New: [A branch reached only by output that follows a kill is covered by the OS pipe, not by the
  test](../lessons/2026-11-04-coverage-must-not-wait-for-the-os-pipe.md).
- Updated: [Timing tests must survive a loaded CI runner](../lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md)
  (fixed per-call cost of a baseline; count-based tests do only the work the count needs) and
  [deterministic full coverage](../lessons/2026-10-15-deterministic-full-coverage.md) (pointer).

## Follow-ups

- #177 (`artifact-ref.test.ts` hook timeout) and #75 (benchmark-engine grace period) stay open in
  #184.
