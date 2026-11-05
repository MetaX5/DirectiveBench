---
title: End every job that fails unexpectedly with a fixed message (issue #70)
date: 2026-11-05
agent: Claude Code / claude-opus-5-5
trigger: maintainer-approved fix of issue #70 via om-auto-fix-issue
status: in-progress
branch: fix/issue-70-fixed-unexpected-job-failure
specs: [SPEC-105, SPEC-114, SPEC-007, SPEC-118, SPEC-009, SPEC-010, SPEC-003]
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

## Second run: issue #193 inside this PR (maintainer decision, 2026-11-05)

The maintainer decided to fix #193 in this PR, then run UI QA and a Codex adversarial review.

- Merged `origin/main` (SPEC-124 Phase 1, the #81 fix, dependency bumps); one conflict in
  `.ai/lessons.md` (both sides added a line), resolved by keeping both.
- `apps/cli/src/logger.ts`: `createFileRunnerLogger` writes the redacted JSON lines to
  `<dataDir>/logs/runner.log` (mode 0600) and prints nothing; `createRunnerLogger` (`serve`) is
  now that logger plus the `[runner]` stderr line. `benchmark run` and `demo` pass
  `createFileRunnerLogger`, so their terminal output is unchanged and the raw error of an
  unexpected failure is the `job-error` line in the log. No pointer to the log is printed (the
  issue allows one but does not require it; the fixed message stays as it is).
- Tests: `logger.test.ts` (file-only logger: lines, redaction, mode 0600, nothing on stderr,
  unwritable file), `benchmark-run.test.ts` and `commands.test.ts` ("keeps the raw error of an
  unexpected failure only in the runner log": a SQLite trigger on `agent_runs`, the built-in
  fake `claude` for `benchmark run`, the mock agent for `demo`).
- Specs: SPEC-114 FR-114-15 and its status, SPEC-118 §20, SPEC-009 (CLI architecture), SPEC-010
  (local installation) data-directory table, and the logging line of SPEC-003.

| Command | Result |
| --- | --- |
| Red first: the three new tests against the unchanged CLI | 3 of 3 fail (`createFileRunnerLogger is not a function`; `ENOENT … logs/runner.log` for `benchmark run` and `demo`) |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test --force` | pass; all 7 test tasks, 100% coverage (cli: 164 tests) |
| `pnpm build && pnpm verify:pack` | pass ("Packaging verification passed") |
| Built CLI `demo` on a fresh data directory | completed, verdict improved; stderr empty; `logs/runner.log` (mode 0600) has the `acquired` and `finished` lines |
| Built CLI `benchmark run --auth api-key --yes` with a fake `claude` and a trigger on `agent_runs` | exit 6, `Error: The benchmark run failed unexpectedly. Try again, and report the problem if it persists.`; the marker path is in neither stdout nor stderr (stderr holds only Node's SQLite ExperimentalWarning); `runner.log` (0600) has one `job-error` line with the raw SQLite text |

### UI QA (`om-auto-qa-pr`, agent-browser, built app from `test-env-up.sh`, mock agent only)

SQLite triggers injected the failures on the running `serve` instance: one on `agent_runs` for a
benchmark run started from the UI, one on `repositories` for a registration, and one on
`artifacts` for a scan.

- Executions page and run page: the fixed benchmark message renders in the job's Details cell
  and in the run's error card. Contrast is about 8:1 in light and about 9:1 in dark
  (`text-destructive-foreground`). At 320px there is no page-level horizontal scroll (the table
  scrolls in its own focusable region, as before). "View run" opens with Enter.
- **Finding (fixed):** the Repositories page wrapped the runner's sentence in its own prefix,
  "The check failed: The repository registration failed unexpectedly. …", and the scan notice
  did the same ("The scan failed: The repository scan failed unexpectedly. …"). The runner now
  stores a complete sentence, so `describeRegistration` and `describeScan`
  (`apps/web/lib/repositories.ts`) show it as it is, with "The check failed." / "The scan
  failed." when no error is stored. Regression: `apps/web/test/repositories.test.ts` (red
  first: 2 tests failed on the old prefix). Re-checked in the rebuilt app at 320px in dark mode:
  the `role=alert` text is the plain sentence, and `runner.log` holds the `job-error` line.
- A scan whose artifact write fails ends with its existing typed outcome ("The scan failed
  while storing the results at … (ERR_SQLITE_ERROR)."), not with the catch-all. The scan's
  catch-all message is covered by unit tests only.
- No en dash or em dash in the new copy. Older copy on these pages still has dashes (the
  Repositories help text, "Planned — not implemented", "—" placeholders); issue #123 tracks them.

## Lessons recorded

- [Inject a real database error with a SQLite trigger, not a mock](../lessons/2026-11-05-inject-database-errors-with-a-trigger.md)

## Follow-ups

- #193 is fixed in this PR (see the second run above).
- A scan whose failure record itself fails leaves `sync_status` as it was. Only the job shows the
  failure.
