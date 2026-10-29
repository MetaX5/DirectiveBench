---
title: Fix the flaky benchmark-run staged-copies test (#143)
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: user request, om-auto-fix-issue 143
status: completed
branch: fix/issue-143-flaky-staged-copies-test
specs: [SPEC-118]
---

# Run: Fix the flaky benchmark-run staged-copies test (#143)

## Objective

Stop "treats the end of input at the confirmation as a no and removes the staged copies"
(`apps/cli/test/benchmark-run.test.ts`) from failing intermittently in CI. Acceptance criteria
from #143: the test checks only the staging directory its own command creates, it still fails
when the staging copy is not removed, and `pnpm test` stays at 100% coverage.

## Plan

Bug chain: `om-verify-in-repo` → `om-root-cause` → `om-fix` → `om-open-pr` → `om-auto-review-pr`.
Test-only change: stub `TMPDIR` to a private directory for the one test and assert it is empty
after the declined run.

## Decisions

- `TMPDIR` stub over a `mkdtemp` spy: it touches less, and the whole `describe` is POSIX-only
  (`describe.skipIf(win32)`), so `TEMP`/`TMP` do not need stubbing yet.
- The assertion is "the private directory is empty" (not a prefix filter): the declined run must
  leave nothing behind at all.

## Work performed

1. Triage: confirmed the shared-tmpdir snapshot at `benchmark-run.test.ts:391-401`; no other
   `readdirSync(tmpdir())` snapshots in `apps/` or `packages/`.
2. Edited the test to stub `TMPDIR`, assert `tmpdir()` follows it, and assert the private
   directory is empty afterwards; added `vi.unstubAllEnvs()` to `afterEach`.
3. Recorded the lesson.

## Verification

- Red-first: with `await rm(staging, …)` at `benchmark-run.ts:443` commented out the test fails
  (`expected [ 'directivebench-suite-vv0ENN' ] to deeply equal []`); restored, it passes.
- Full gate: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (100% in every
  package), `pnpm build`, `pnpm verify:pack`: all exit 0.
- `apps/cli` Vitest run 3 times in a row: 132/132 each time.
- Not verified: the original race was not reproduced locally (inferred from CI logs and code);
  "several consecutive green CI runs" is left to the PR's CI.

## Problems and deviations

None.

## Lessons recorded

- [Tests never snapshot shared global state such as `os.tmpdir()`](../lessons/2026-10-29-tests-never-snapshot-shared-tmpdir.md)

## Follow-ups

- When #120 adds Windows gates, stub `TEMP`/`TMP` too if this suite is enabled on Windows.
