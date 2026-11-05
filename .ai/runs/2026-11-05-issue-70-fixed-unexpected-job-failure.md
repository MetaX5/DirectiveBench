---
title: End every job that fails unexpectedly with a fixed message (issue #70)
date: 2026-11-05
agent: Claude Code / claude-opus-5-5
trigger: maintainer-approved fix of issue #70 via om-auto-fix-issue
status: completed
branch: fix/issue-70-fixed-unexpected-job-failure
specs: [SPEC-105, SPEC-114, SPEC-007]
---

# Run: End every job that fails unexpectedly with a fixed message (issue #70)

## Objective

Any job (registration, scan, benchmark) that throws an error no step turned into an outcome of
its own ends `failed` with a fixed message naming the job type. The raw error is kept only in the
redacted runner log (SPEC-007 §3.1), and cancellation and shutdown keep `cancelled` and
`interrupted`. Acceptance criteria are those of issue #70. There is no separate "import" job type:
`JOB_TYPES` is `benchmark-run`, `repository-registration` and `repository-scan`, and example
import runs in-process, not as a job.

## Plan

1. `om-verify-in-repo`: confirm on `origin/main` that `LocalRunner.execute` ends a job with
   `error.message` (generic catch) and the benchmark catch stores the raw message.
2. `om-root-cause` and `om-fix` in a worktree under `.ai/tmp/`: add `UNEXPECTED_JOB_FAILURE` per
   job type, log the raw error (or the SQLite cause of a Drizzle error) as `job-error`, and keep
   the messages written for the user (`BenchmarkConfigurationError`, `BenchmarkStoppedError`).
3. Add regression tests per job type with injected errors (SQLite triggers), and update SPEC-114
   and SPEC-105 §13.
4. Run the gate, build, `verify:pack`, a real `serve` run with an injected error, and `demo`.
5. `om-open-pr --handoff`, then `om-auto-review-pr --autofix` (review submitted as COMMENT).

## Decisions

- **Messages written for the user stay as they are.** `BenchmarkConfigurationError` (the suite
  cannot run here) and `BenchmarkStoppedError` (FR-118-15 stop code) keep their text. So do the
  typed scan and registration outcomes, which never reached the generic catch. Everything else
  gets the fixed message.
- **A malformed benchmark payload** is now read with `safeParse` and ends with "The stored
  benchmark request is invalid: <path>: <reason>", as registration and scan payloads already do.
  Before, the raw ZodError JSON reached the generic catch.
- **The runner log keeps the cause, not Drizzle's query text.** This follows the existing
  `shutdown-interrupt-failed` precedent: the cause says why, and the query parameters could hold
  user data.
- **The message does not point at the runner log**, because `benchmark run` and `demo` pass no
  logger. It follows the wording of the existing `UNEXPECTED_HOSTED_FAILURE`.

## Work performed

- `packages/runner/src/runner.ts`: `UNEXPECTED_JOB_FAILURE`, `describeUnexpectedError`,
  `unexpectedFailure` (logs `job-error` with `jobId`, `jobType`, `benchmarkRunId`); the benchmark
  catch and the generic catch use it; the benchmark payload is read with `safeParse`.
- `packages/runner/test/runner-unexpected-errors.test.ts` (new): a local and a hosted
  registration, a local and a hosted scan, each failed by a trigger on `repositories`.
- `packages/runner/test/runner-lifecycle.test.ts`: the benchmark cases now expect the fixed
  message and the `job-error` log entry, plus a trigger on `agent_runs` and the malformed-payload
  message.
- SPEC-114 FR-114-10, FR-114-15 events, §13, implementation status; SPEC-105 §13 and status.
- Lesson `2026-11-05-inject-database-errors-with-a-trigger`.

## Verification

| Command | Result |
| --- | --- |
| Red first: the new test file against the unchanged `runner.ts` | 4 of 5 failed (raw Drizzle text as the job error); 5/5 pass with the fix |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test --force` | pass; runner 241 tests, 100% coverage threshold met in every package |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass ("Packaging verification passed") |
| Real run: built CLI `init`, trigger on `repositories`, pending registration job, `serve --no-open --port 4399` | job `failed` with "The repository registration failed unexpectedly. Try again, and report the problem if it persists.", `result` null; `logs/runner.log` has one `job-error` line with the raw SQLite text; `serve` stopped on SIGINT |
| Built CLI `demo` on a fresh data directory | completed, verdict improved |

Not verified: how the web UI renders these messages (the change is text only, and the UI shows
`jobs.error` and `benchmark_runs.error` as before); a real Claude Code run (never run here).

## Problems and deviations

- `pnpm test` first replayed cached results for the packages that depend on the runner, so the
  gate was run again with `--force`.

## Review

- `om-auto-review-pr 192 --autofix` round 1 (engine `om-code-review`) at `a574b60`: no blockers and
  no majors. The review was submitted as COMMENT at the maintainer's instruction; its own verdict
  would be approve. One minor (`benchmark run`/`demo` keep no raw error) was filed as #193; one
  nit (no stack in the log) was left as optional. The autofix loop had nothing to fix.
- `om-auto-qa-pr` was not run. The change is text-only, and the maintainer's brief named the chain
  without it. The PR keeps `needs-qa`, and the review lists P0 to P2 manual QA steps.

## Lessons recorded

- [Inject a real database error with a SQLite trigger, not a mock](../lessons/2026-11-05-inject-database-errors-with-a-trigger.md)

## Follow-ups

- #193: `benchmark run` and `demo` create their `LocalRunner` without a logger, so there the raw
  error of an unexpected failure is not kept anywhere. Give them a file-only runner log.
- A scan whose failure record itself fails leaves `sync_status` as it was. Only the job shows the
  failure.
