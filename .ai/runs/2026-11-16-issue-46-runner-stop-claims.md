---
title: Interrupt jobs claimed after stop() began without running them, and log failed outcome writes (issue 46)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issue 46 (follow-up from PR 44), approach approved 2026-11-16
status: completed
branch: fix/issue-46-runner-stop-claims
specs: [SPEC-114]
---

# Run: runner stop() claims and unobserved outcome writes (issue 46)

## Objective

Fix issue 46 with both approved measures:

1. A job that `fill()` claims after `LocalRunner.stop()` began is marked `interrupted` directly,
   without running `execute()` (no adapter detect, no `createBenchmarkRun`, no scan or git).
2. Every job's `done` chain catches a failure to record its outcome (for example `finishJob`
   rejecting after `directivebench serve` closed the database) and logs it through the runner
   logger, so there is no unhandled promise rejection and no silently swallowed error.

Acceptance criteria (issue 46): both measures; shutting down with a job that outlives `stop()`
causes no unhandled rejection; runner tests cover a claim after the stop deadline and a job that
outlives `stop()` whose `finishJob` rejects; coverage stays at 100%.

Non-goals: `apps/web`, `packages/database/src/repositories/jobs.ts`,
`packages/runner/src/repository-scan.ts` (another agent works there); changing `serve`'s close
order; recovering such jobs differently (the existing `recoverStaleJobs` stays the backstop).

## Plan

- `track()` chooses `interruptClaimed(job)` instead of `execute()` when `this.stopping` is set:
  one guarded `finishJob(..., 'interrupted', 'Runner shut down before the job started')` and the
  usual `finished` log event. The job stays in `active` until that write settles, so a `stop()`
  still waiting for its poll also waits for it.
- `track()` attaches a handler to `done` that logs a rejection as `outcome-not-recorded` (error
  level, raw cause via `describeUnexpectedError`). `done` itself still rejects, so
  `runAcquiredJob` and `runUntilIdle` callers see the failure as before.
- Tests in `runner-lanes.test.ts` and `runner-lifecycle.test.ts`, written red first (the final
  list is under Work performed).
- SPEC-114 §20: record both behaviours and the new log event.

## Decisions

- A job claimed while `stop()` still waits for its poll (before the deadline) is also recorded
  `interrupted` without running: the approved rule is "claimed after `stop()` began", and
  running it only to abort it at once gains nothing. The existing test "stop() waits for a job
  that a poll is claiming" now asserts the scan never starts.
- `done` still rejects after it is logged, so `runAcquiredJob` (`benchmark run`) and
  `runUntilIdle` (`demo`) keep reporting the failure to their callers as before.
- The interrupted job's error is "Runner shut down before the job started", next to the
  timeout path's "Runner shut down before the job stopped".

## Work performed

- `3e44638` fix(runner): `track()` calls `interruptClaimed()` instead of `execute()` when
  `stopping`; every `done` gets a handler that logs `outcome-not-recorded`. Tests: the two
  existing claim-during-stop tests in `runner-lanes.test.ts` now assert the scan never starts;
  new tests for a late-claimed job whose interrupt write rejects (no unhandled rejection), for a
  job that outlives `stop()` on a connection closed afterwards, and (in
  `runner-lifecycle.test.ts`) for a late-claimed benchmark job (no `detect()`, no benchmark run).
- SPEC-114 §20: new status entry and the `outcome-not-recorded` event in FR-114-15.

## Verification

- Red first (tests before the fix, on `origin/main` code): 4 of the new or changed tests failed —
  the late-claimed scan ran (`status` and error mismatch), the late-claimed benchmark job ran,
  the outlived job's failure was not logged as `outcome-not-recorded`, and the late-claimed job
  whose write rejected caused 1 `unhandledRejection` ("expected vi.fn() to not be called at all,
  but actually been called 1 times").
- After the fix: `pnpm format:check`, `pnpm lint`, `pnpm typecheck` pass; `pnpm test` passes in
  every package with 100% statements, branches, functions and lines (runner: 293 tests).
- `taskset -c 0,1` runs of `runner-lanes`, `runner-lifecycle`, `runner-acquired` and `runner`
  tests: 5 of 5 passed.
- `pnpm build` passes; the built CLI's `demo` completed with the mock agent (verdict improved),
  and `serve` on the same data directory started and shut down on SIGINT with no unhandled
  rejection or `outcome-not-recorded` line.
- Not verified: the exact race in a real `serve` shutdown (a claim landing after the deadline,
  then the database closing) — it needs a transaction held across the deadline, which only the
  unit tests produce.
- `pnpm verify:pack` passes (with `TMPDIR` under `.ai/`, removed afterwards). On head `06bbb1a`,
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test` (100% in all 7 packages)
  were re-run and pass.
- Codex adversarial review (`--scope branch --base main`, round 1 on `06bbb1a`): approve, no
  findings.
- `om-auto-review-pr` (engine `om-code-review`, COMMENT review since self-authored): approve, no
  blocker, major or minor. There were two nits: this Plan section (fixed), and the `job-error`
  event that comes before `outcome-not-recorded` (left as a follow-up).

## Problems and deviations

- The first regression test for the second measure (a job that outlives `stop()`) showed no
  unhandled rejection on the old code. `stop()`'s `Promise.allSettled` already observed those
  jobs. The unobserved path was a job claimed after `stop()` took its snapshot. A second test
  covers that path with a mocked `finishJob` rejection and fails on the old code with 1
  `unhandledRejection`.
- Two existing tests in `runner-lanes.test.ts` asserted that a claim during `stop()` starts the
  scan and aborts it. They now assert that the scan never starts. Their unused `scanStarted`
  helper was removed.

## Lessons recorded

- [Prove an unhandled-rejection fix on the promise nobody awaits](../lessons/2026-11-16-prove-an-unhandled-rejection-on-the-promise-nobody-awaits.md)

## Follow-ups

- When a job's outcome write fails because the database is closed, the runner logs `job-error`
  ("failed unexpectedly") from `execute()`'s catch before `outcome-not-recorded`. A single event
  would read better (review nit).

## Progress

PR: #240

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Runner fix

- [x] 1.1 Red-first tests for both cases — 3e44638
- [x] 1.2 Interrupt late claims without execute() and log failed outcome writes — 3e44638
- [x] 1.3 Update SPEC-114 implementation status — 06bbb1a

### Phase 2: Verification and review

- [x] 2.1 Full quality gate and repeated runs under taskset
- [x] 2.2 Codex adversarial review until approved
- [x] 2.3 om-auto-review-pr verdict
