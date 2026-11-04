---
title: Fix the flaky macOS runner-acquired test (issue #174)
date: 2026-11-04
agent: Claude Code / claude-opus-5-5
trigger: maintainer chose issue #174; run through om-auto-fix-issue
status: completed
branch: fix/issue-174-serve-runner-flaky-failed-job
specs: [SPEC-118]
---

# Run: Fix the flaky macOS runner-acquired test (issue #174)

## Objective

`packages/runner/test/runner-acquired.test.ts` "a serve runner polling the same data directory
never acquires the CLI job" fails intermittently on the macOS unit job: the job enqueued through
the serve runner ends `failed`. Acceptance criteria (issue #174): the test reports the job's and
run's error on failure; the root cause is reproduced and fixed at the root, not by raising
timeouts; a regression test if the cause is in product code; the macOS job is green on repeated
runs.

## Plan

1. Make the test print the failed job's error and its benchmark run's error.
2. Reproduce on Linux under load (`taskset`, `yes`), and on macOS through a temporary probe
   workflow on a throwaway branch if Linux does not reproduce.
3. Fix the root cause, add a regression test where the cause is in product code.
4. Quality gate, review, PR.

## Decisions

- The fix is in the test, not in product code: every product process opens one writable
  connection (`serve`, `benchmark run`, the web app each in their own process; `benchmark run`
  closes its first handle before it opens the next), so two writable connections in one thread
  exist only in this test. The test now gives both runners one connection, which is what
  separates them in production anyway: the job row (`running` for the CLI runner) keeps `serve`
  off the CLI job, not the connection.
- No timeout was raised.
- Evidence was collected on macOS through a throwaway branch `probe/issue-174-macos` with a
  temporary workflow (`on: push` for that branch only); the branch is deleted at the end and was
  never part of a PR.

## Work performed

1. Made the test report the queued job's `error` and its benchmark run's `error`, and remove its
   data directory (it left one in `os.tmpdir()`).
2. Linux reproduction attempts, all green: the test alone 12x under `taskset -c 0,1` with four
   `yes`; the runner package 5x under `taskset -c 0,1` with three `yes`; three parallel copies
   of the file on one core with six `yes`; an in-process detector of statements running on one
   connection while another had a transaction open never fired (it did not watch `BEGIN`, which
   is where the overlap was).
3. Proved the mechanism in isolation (`node:sqlite`, two WAL connections in one thread,
   `busy_timeout = 5000`): a write on the second connection while the first holds
   `BEGIN IMMEDIATE` fails after 5006 ms with `database is locked`, and only then does the first
   commit.
4. macOS probe 1 (4 shards, full suite): one failure, now with the error printed:
   `"error": "Benchmark failed: database is locked"`, on the CLI job this time.
5. macOS probe 2 (6 shards x 3 full suites, `client.ts` instrumented): one failure, with
   `BEGIN IMMEDIATE` waiting 6942 ms while the other connection's transaction, opened in
   `insertAgentRun` (`runs.ts:88`, from `LocalRunner.persistAgentRun`), stayed open.
6. Fix: both runners share one connection (commit `17d1603`), lesson recorded.
7. Deterministic red/green check of the mechanism (temporary vitest file, not committed): runner
   A's `withTransaction` spans a timer while runner B begins its own; with two connections in one
   thread B fails after 5012 ms with `database is locked`, with one shared connection both pass.

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass, 7/7 packages, runner coverage 100% (884/884 statements, 505/505 branches) |
| `pnpm build` | pass |
| `pnpm verify:pack` (`TMPDIR` on disk under `.ai/tmp`) | pass |
| macOS before the fix (probe runs 41816459481, 41817427688): 22 full suites | 2 failures of this test (`database is locked`) |
| macOS after the fix (probe run 41818398600): 18 full suites (6 shards x 3) | 0 failures of this test; 1 unrelated failure (`packages/database/test/artifact-ref.test.ts` `beforeEach` hook timed out in 10 s) |

Not verified: the regular `Unit tests (100% coverage, macOS)` job on repeated reruns of the PR
(the probe ran the same `pnpm test --continue --concurrency=2` on `macos-latest`). The failure
rate before the fix was about 1 in 11 full suites, so a green sample bounds the rate, it does not
prove zero; the mechanism check in step 7 is the deterministic part of the proof.

## Problems and deviations

- The first probe workflow failed at once: GitHub runs `bash -e -o pipefail`, so a `grep` with no
  match ended the step. The second used `set +e +o pipefail`. Its per-file loop also failed on the
  coverage threshold (coverage on, a subset of files), which is noise, not a test failure.

## Lessons recorded

- [2026-11-04-one-writable-connection-per-test-thread](../lessons/2026-11-04-one-writable-connection-per-test-thread.md)

## Follow-ups

- `packages/database/test/artifact-ref.test.ts`: `useTestDatabase`'s `beforeEach`
  (`openTestDatabase()`) timed out at 10 s once in the 18 macOS suites after the fix (job
  126534997895); unrelated to this change, needs its own issue (filing it from this run was
  refused by the permission system).

- `packages/runner/test/runner-lifecycle.test.ts` "two runners sharing one database" opens a
  second writable connection in the same thread and runs benchmark jobs on both at once ("splits
  a queue between runners"): the same hazard, not seen failing yet. Needs its own issue (not filed
  from this run, see above).
- The throwaway `probe/issue-174-macos` branch was deleted after the runs.
