---
title: Flaky macOS process test after an abort with a TimeoutError reason (issue 286)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #286 (maintainer approved), run through om-auto-fix-issue
status: completed
branch: fix/issue-286-abort-timeout-test
specs: [SPEC-203]
---

# Run: flaky macOS process test after an abort with a TimeoutError reason (issue 286)

## Objective

`packages/agent-adapters/test/claude-code/process.test.ts` "treats an abort with a TimeoutError
reason as a timeout" failed on the macOS unit job of `main` (run 44531474071, job 135585774896,
attempt 1) with `Test timed out in 5000ms`, reported after 12,386 ms; the rerun passed. Find where
the time went; fix `runClaudeProcess` if a timed-out run can take seconds to stop, otherwise fix
the test; prove it with 30 repetitions on two loaded cores.

## Plan

1. Read the failing job log (attempt 1) and the abort path (`runClaudeProcess`,
   `process-group.ts`) with every timer and poll in it.
2. Instrument the phases temporarily (spawn, pid visible, abort, SIGTERM, SIGKILL, exit, group
   gone, close, result) and measure them alone and on two loaded cores.
3. Decide product versus test from the evidence, fix, prove red/green, update the lesson.

## Decisions

- **Test fix, not a product fix.** Evidence below: the abort path is bounded and fast, and the
  CI duration can only come from a stalled vitest worker.
- **One named timeout for every test that starts the fake** (`FAKE_CLAUDE_TEST_TIMEOUT_MS`,
  30 s, in `fake-claude.ts`), set on the `describe` blocks of `process.test.ts`, `run.test.ts`
  and `adapter.test.ts`. The three literal `30_000` per-test timeouts in `process.test.ts` now use
  it. It is longer than `waitFor`'s readiness bound (`FAKE_CLAUDE_READY_TIMEOUT_MS`, 10 s, the
  previous literal default), which before could never fire inside vitest's 5 s.
- The test already waits for a real readiness signal: the fake writes its pid after `sleep &`,
  and `trap '' INT TERM` is its first command, so no change there.

## Work performed

1. Read the failing attempt (`gh run view 44531474071 --attempt 1 --log-failed`): runner image
   `macos-26-arm64` 20261112.0504.1. In the same file the other abort tests were on time
   (AC-10 5,180 ms for a 5 s grace, EPERM 2,195 ms, escalation 353 ms, Windows path 1,243 ms);
   only this test was reported at 12,386 ms.
2. Read vitest 5.1.0's `withTimeout`: its `TaskDeadline` timer fires at the limit and rejects;
   on resolution it also fails a test that exceeded the limit. A test whose asynchronous work is
   slow is therefore reported at ~5,000 ms. Only a stalled event loop (a blocking synchronous
   call, or a process off the CPU) can report it later.
3. Signature experiment (temporary scratch test, the same `hang` fake and abort): a 7 s
   `Atomics.wait` (synchronous stall) failed at 7,019 ms; a 7 s `setTimeout` (slow async phase)
   failed at 5,004 ms. A 12 s synchronous stall injected into the real test reproduced CI
   exactly: `Test timed out in 5000ms`, reported at 12,023 ms.
4. Abort path audit (`runClaudeProcess`, `process-group.ts`): every wait is named and bounded,
   and none grows: grace (`killGraceMs`, 100 ms here), `PROCESS_KILL_CONFIRM_MS` 2 s after
   SIGKILL, `PROCESS_GROUP_EXIT_TIMEOUT_MS` 2 s polled every `PROCESS_GROUP_POLL_MS` 10 ms,
   `PROCESS_OUTPUT_DRAIN_MS` 1 s concurrent with it. No `ps`, `/proc` or other platform-specific
   lookup is on the path (macOS uses the same `kill(-pgid, 0)`). The worst case after an abort is
   about 2.1 s, all asynchronous, so it cannot produce a 12.4 s report.
5. Phase timings (temporary `globalThis.__phase` marks in `process.ts`, removed before commit),
   30 repetitions each, ms (min / median / max):

   | Phase | Idle | 2 loaded cores (4 `yes` + full `turbo run test --force` on cores 0,1), before | 2 loaded cores (4 `yes`), after |
   | --- | --- | --- | --- |
   | `spawn()` (synchronous) | 1 / 2 / 3 | 3 / 11 / 37 | 2 / 6 / 11 |
   | spawn returned to pid visible | 9 / 10 / 12 | 16 / 29 / 43 | 9 / 12 / 21 |
   | abort to SIGTERM | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
   | SIGTERM to SIGKILL (grace 100) | 100 / 100 / 101 | 99 / 101 / 103 | 99 / 100 / 102 |
   | SIGKILL to exit | 0 / 0 / 1 | 0 / 0 / 5 | 0 / 0 / 3 |
   | exit to group gone | 1 / 10 / 11 | 0 / 11 / 28 | 0 / 10 / 14 |
   | close to result | 0 / 10 / 11 | 0 / 9 / 17 | 0 / 9 / 12 |
   | abort to result | 102 / 111 / 112 | 102 / 114 / 128 | 101 / 111 / 116 |
   | whole test | 114 / 123 / 128 | 143 / 158 / 204 | 119 / 129 / 140 |
   | max event-loop lag | 0 / 1 / 1 | 3 / 7 / 54 | 0 / 3 / 6 |

   Group never left over, drain never forced. The production path stops a timed-out run in
   ~0.1 s; the 12 s did not come from it.
6. Fix (test only): `FAKE_CLAUDE_TEST_TIMEOUT_MS` (30 s) and `FAKE_CLAUDE_READY_TIMEOUT_MS`
   (10 s, `waitFor`'s default) in `fake-claude.ts`; the timeout is set on the fake-starting
   `describe` blocks of `process.test.ts`, `run.test.ts` and `adapter.test.ts`. Sizing: 2.4x the
   12.4 s CI worst case, and the AC-10 test's 5 s grace plus its bounded waits stay well inside.
   Commit `7550851`.

## Verification

| Command | Result |
| --- | --- |
| Signature: 7 s `Atomics.wait` vs 7 s `setTimeout` in a `hang` abort test, 5 s default | sync stall reported at 7,019 ms, async delay at 5,004 ms |
| Red: 12 s synchronous stall injected in the real test, without the named timeout | `Test timed out in 5000ms`, reported at 12,023 ms (CI: 12,386 ms) |
| Green: same injected stall with `startsTheFake` | passes |
| Before, 2 loaded cores: 30 instrumented repetitions + full `taskset -c 0,1 turbo run test --force` alongside, 4 `yes` | 30/30 pass; gate 7/7 tasks; `process.test.ts` 11.7 s file |
| After, 2 loaded cores (4 `yes`): 30 instrumented repetitions | 30/30 pass |
| After, 2 loaded cores (4 `yes`): the real test, 30 separate `vitest run -t` invocations | 30/30 pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm exec turbo run test --force` | 7/7 tasks pass, 100% coverage in every package |

`src` is unchanged, so `pnpm build && pnpm verify:pack` were not needed.

Not verified: a real macOS machine (none available); which synchronous call or scheduling gap
stalled the macOS worker is not known (candidates: a blocking `fs` call or `spawn` on the
virtualised APFS disk, or the 3-core VM taking the worker off the CPU). The original failure
does not reproduce on Linux without the injected stall.

## Problems and deviations

- `gh run view --job` shows the latest attempt (the passing rerun); the failing attempt is
  `gh run view 44531474071 --attempt 1 --log-failed`.

## Lessons recorded

- Updated `.ai/lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md` and its index
  line: a vitest timeout reported far beyond its limit means a stalled worker, not slow
  asynchronous code; child-process tests get a named timeout above their readiness wait.

## Follow-ups

- If the macOS job ever reports a fake-claude test beyond 30 s, the worker stall is longer than
  sized here: measure the stall (event-loop delay) on the macOS runner instead of raising the
  timeout again.
