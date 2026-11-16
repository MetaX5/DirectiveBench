---
title: Interrupt jobs claimed after stop() began without running them, and log failed outcome writes (issue 46)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issue 46 (follow-up from PR 44), approach approved 2026-11-16
status: in-progress
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
- Tests in `packages/runner/test/runner-lanes.test.ts`: the existing "claim after the deadline"
  test now asserts the scan never starts (red on the old code); a new test runs the runner on
  its own connection, stops it while a job ignores the abort, closes that connection, releases
  the job and asserts the logged event and no `unhandledRejection`.
- SPEC-114 §20: record both behaviours and the new log event.

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Runner fix

- [ ] 1.1 Red-first tests for both cases
- [ ] 1.2 Interrupt late claims without execute() and log failed outcome writes
- [ ] 1.3 Update SPEC-114 implementation status

### Phase 2: Verification and review

- [ ] 2.1 Full quality gate and repeated runs under taskset
- [ ] 2.2 Codex adversarial review until approved
- [ ] 2.3 om-auto-review-pr verdict
