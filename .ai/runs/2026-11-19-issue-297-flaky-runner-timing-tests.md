---
title: Fix the two flaky runner timing tests from PR 293's first CI run (issue 297)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5 (om-auto-fix-issue)
trigger: user request (brief filed as issue 297)
status: completed
branch: fix/issue-297-flaky-runner-timing-tests
specs: []
---

# Run: Fix the two flaky runner timing tests (issue 297)

## Objective

Two `packages/runner` tests failed in the first CI attempt of PR #293 (run 44554536200,
attempt 1) and passed on rerun: `runner-cache-sweep` "keeps running jobs when a sweep fails"
(Linux, job 135666916328) and `git-process` "kills git on timeout, with SIGKILL when it ignores
SIGTERM" (macOS, job 135666916393). Find each root cause from evidence, reproduce it, fix it
without raising a timeout, and prove it under load.

## Plan

1. Read both failure logs. 2. Reproduce each under load (`yes` load, repeated runs, as in the
issue 286 run). 3. Fix the root cause, red first. 4. Gate, lesson, PR, `om-auto-review-pr`.

## Decisions

- **Cache sweep: test defect.** `LocalRunner.start()` starts the sweep without delaying the first
  job (SPEC-105 FR-105-19, and the neighbouring test "sweeps at start ... without delaying the
  first job" requires it), so the order of the job's end and the sweep's error log is not
  defined. The test now waits for the log with `vi.waitFor`. No product change.
- **git timeout: product defect.** The 5,015 ms is the script's `sleep 5`: a child forked while
  the process group got SIGKILL missed the signal and held the pipes, and `close` waited for it.
  `runGitProcess` now kills the group again when git's `exit` arrives after a SIGKILL. Real git
  forks helpers, so a timed-out or cancelled download could otherwise overrun its timeout.
- No spec change: the documented behaviour (SIGTERM, then SIGKILL to the group) is unchanged;
  this makes it hold when the group forks during the kill.
- No timeout raised. The new regression test has a named timeout (`GIT_KILL_TEST_TIMEOUT_MS`)
  above its readiness wait, per the issue 286 lesson.

## Work performed

1. Downloaded both job logs (`gh api .../actions/jobs/<id>/logs`); filed issue 297, claimed it.
2. Worktree `.ai/tmp/wt-297` from `origin/main` (1cb689c).
3. git timeout reproduction: a temporary stress test (not committed) calling the real
   `runGitProcess` with the test's script. With the test's 50/50 ms values: 0 hangs in 200 idle
   and 400 loaded runs. With `timeoutMs: 1` and `killGraceMs` 0 to 3 ms, 8 concurrent, 20 `yes`
   on 10 cores: hangs of 5,013 to 5,045 ms. `ps` during a hang:
   `40512 1 40508 S sleep 5`, an orphan (parent 1) still in the killed group 40508.
4. Cache sweep reproduction: 40 isolated runs and 5 full runner-suite runs under load did not
   fail. A 200 ms delay injected before the sweep's `realpath` reproduced the CI assertion
   exactly (`expected [ acquired, finished ] to deep equally contain { level: 'error', ...
   cache-sweep-failed }`); with `vi.waitFor` the test passes with the delay in place. Delay
   reverted.
5. Regression test "kills a child that git forked while its group was killed, once git is gone
   (issue 297)": spies on `process.kill` so the first group SIGKILL reaches only the leader,
   which is the race's outcome. Red: timed out at 20,003 ms. Green after the fix.
6. Updated "survives a process group that is already gone" to the new signal sequence
   (`SIGTERM`, `SIGKILL`, `SIGKILL`).

## Verification

| Command | Result |
| --- | --- |
| Stress, real `runGitProcess`, `timeoutMs: 1`, grace 1/2/3 ms, 3 x 4,000 runs, loaded, **before** | 5 hangs (5,035 to 5,045 ms) |
| Same, **after** | 0 hangs in 12,000; then 0 in 3 x 8,000 more (grace 0/1/2), max 224 ms |
| Red first: new regression test before the fix | timed out at 20,003 ms |
| Cache sweep with 200 ms injected sweep delay, before / after | fails with the CI assertion / passes |
| `vitest run test/git-process.test.ts test/runner-cache-sweep.test.ts` x 30 under load (20 `yes`, 10 cores) | 30/30 pass |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test` | pass, 7/7 tasks, 100% coverage in every package |
| `pnpm build && pnpm verify:pack` | pass ("Packaging verification passed") |

**Not verified:** the macOS CI runner itself (the race was reproduced on a local Apple Silicon
Mac); Linux behaviour of the git race (Linux handles signals pending during `fork`, so it is not
expected there, and the extra SIGKILL is harmless); Windows (no process groups; the `exit`
handler only re-signals the child, which is already gone). The cache-sweep race was not caught
naturally locally, only with the injected delay.

## Base merge (2026-11-20, `om-auto-fix-pr 299`)

PR #299 was `CONFLICTING` after main took #300, #293, #292 and others. Merged `origin/main`
(2cc16f1) into the branch in a worktree under `.ai/tmp/om-auto-fix-pr/`.

- Conflict: `.ai/lessons.md` only. Both sides added a new 2026-11-19 entry at the top of the
  index (this PR's process-group SIGKILL lesson; main's turbo-needs-`pnpm`-on-PATH lesson). They
  are separate lessons, so the merge keeps both lines.
- No code conflicts. Main's changes near this PR (`test-support/linear-time.ts`,
  `apps/web/vitest.config.ts`, the Node 22.16 timing lesson) do not touch `git-process.ts` or the
  runner tests this PR changes.

| Command (after the merge) | Result |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test` (full, load average 30 from parallel agent gates) | fail: three 5 s timeouts in files this PR does not touch (`missing-occurrences`, `output-files`, `claude-code-adapter`) |
| `pnpm test` in `packages/benchmark-engine` | pass, 100% coverage |
| `pnpm test` in `packages/runner`, first re-run (load 31) | fail: another untouched test timed out (`hosted-repository-limits`) |
| `pnpm test` in `packages/runner`, second re-run | pass, 322/322, 100% coverage |
| `pnpm build && pnpm verify:pack` | pass ("Packaging verification passed") |

The timeouts moved between unrelated tests from run to run and were caused by machine load, not
by the merge. CI on the merged head is the clean check.

## Problems and deviations

- `turbo` needs `pnpm` on `PATH`; used a shim in `.ai/tmp/bin297` calling `corepack pnpm`.
- Overlap: #160 (Windows test gate) also edits `packages/runner` tests; this change touches only
  `git-process.ts`, `git-process.test.ts` and `runner-cache-sweep.test.ts`.

## Lessons recorded

- New: `.ai/lessons/2026-11-19-kill-the-process-group-again-after-the-leader-exits.md`.
- Updated: `.ai/lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md` (wait for the
  event of background work that runs alongside a job).

## Follow-ups

- `runCommand` (benchmark-engine) and `runClaudeProcess` (agent-adapters) also kill process
  groups and were not checked or changed here. Worth checking for the same fork race.
