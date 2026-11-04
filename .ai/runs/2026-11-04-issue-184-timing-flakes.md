---
title: Fix three timing-dependent tests of issue 184 from evidence
date: 2026-11-04
agent: Claude Code / claude-opus-5-5
trigger: issue #184 (umbrella), maintainer-approved, om-auto-fix-issue 184
status: completed
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
- Fix: the case reads `BASELINE_LARGE = 64 MiB` (small 2 MiB).
- Review finding (self-review, fixed): the case also has to fail when the helper picks the thread
  clock (the bug it guards). With the helper patched to always use the thread clock, the ratio was
  not ~1 as its comment said: the thread clock bills work per wall-clock time, so the baseline
  still grows 2–3×. Ratios with the patched helper (temporary probe, 3 per run):
  - Linux, 4 free cores: 8 MiB 0.43–0.72, 16 MiB 0.39–0.57, 32 MiB 0.35–0.43, 64 MiB 0.34–0.46;
    under load (`taskset -c 0,1` + loaded loop): 8 MiB 0.79–0.94, 64 MiB 0.55–0.67.
  - macOS (probe job 126819856877, idle and during a full suite): 8 MiB 0.39–0.84, 64 MiB
    0.293–0.53; the correct helper there: 8 MiB 0.10–0.22, 64 MiB 0.017–0.033.
  So against the borrowed bound 1 / MAX_LINEAR_RATIO = 0.286 the 64 MiB case could no longer tell
  the clocks apart (0.293 on macOS), and the 8 MiB case could not hold the correct clock (0.338
  locally, 0.22 on macOS). The case now has its own bound `PROCESS_CLOCK_MAX_RATIO = 0.1`, between
  the two clocks (correct at most 0.039, broken at least 0.293): margins 2.6× and 2.9×. The shared
  helper and `MAX_LINEAR_RATIO` are unchanged. Red: with the patched helper the case fails
  "expected 0.3018 to be less than 0.1"; unpatched it passed 2/2 runs of the file.

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

### 4. `engine.test.ts` "sends SIGTERM first and SIGKILL only after the grace period" (#75)

- Out of the brief's scope, but it failed in this run's own gate (`pnpm test --force`, load
  average 10 from parallel work on the machine): `expected { … } to match object { timedOut:
  true, exitCode: 7 }`, received `exitCode: null`. The children were Node.js scripts that install
  their SIGTERM handler only after start-up, against a 300 ms timeout: the failure of lesson
  `2026-10-21-timing-tests-must-survive-a-loaded-runner`, already fixed the same way in
  `commands.test.ts`. A temporary 400 ms busy-wait before the handler reproduced the identical
  output every time.
- Not reproduced by load alone: 24 runs (4 parallel) under `taskset -c 0,1` + six `yes`, 16 with
  sixteen `yes`, 36 during a full `pnpm test --force`: all passed.
- Fix: both children are `sh -c` loops whose trap is set within a millisecond of start
  (`trap 'exit 7' TERM`, and `trap '' TERM`, which the `sleep` children inherit). After: 52 of 52
  runs passed under `taskset -c 0,1` + six `yes` with four parallel copies (#75 asks for 50).
  Red: with the grace period forced to 0 in `runCommand` the test fails "expected 317 to be
  greater than or equal to 550".

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test --force`: passed, 7/7 test
  tasks, 100% coverage.
- Repeated runs on the final head 493fcfb:
  - Linux: 10/10 full `taskset -c 0,1 pnpm test --force` suites with two `yes` on the same cores
    passed (about 350 s each). `process.ts` was at 100% in all 10; the slug test took 1.8–2.2 s
    and the linear-time control 2.0–2.2 s.
  - macOS probe (throwaway branch `probe/issue-184-macos`, deleted; run 41900090326, 3 full
    `pnpm test --continue --concurrency=2 --force` suites per shard): with the new tests 9/9
    suites green. With main's tests for `process.ts` 6/6 green and one shard cancelled, so the
    coverage flake did not recur in 6 suites; it is rare. A ratio job measured the linear-time
    numbers above on macOS (correct clock 0.014–0.039).
  - PR #186 CI on 493fcfb: all checks green.
- Review: `om-auto-review-pr 186 --autofix` approved (posted as COMMENT) after its two findings
  were fixed: the weak linear-time control (major, own bound 0.1 in 5b71674) and the #75 gate
  failure (blocker, 493fcfb).
- Not verified: the macOS `process.ts` mechanism was not reproduced directly, and the 0.338
  linear-time failure was not reproduced; the evidence is the measured margins. #75 did not fail
  under load alone in 76 runs before the fix.

## Problems and deviations

- PR #186 was merged (f7af5bf) before this log was finalised; the final results above were
  first posted on issue #184 and are recorded here in a docs-only follow-up from main.
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

- #177 (`artifact-ref.test.ts` hook timeout) stays open as its own watch item. The maintainer
  closed #75 (fixed in 493fcfb) and the umbrella #184 on 2026-11-04.
