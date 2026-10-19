---
title: Fix the flaky serve SIGINT test (#38)
date: 2026-10-19
agent: Claude Code / claude-opus-5-5
trigger: maintainer request, issue #38 (om-auto-fix-issue)
status: completed
branch: fix/issue-38-flaky-serve-sigint-test
specs: []
---

# Run: Fix the flaky serve SIGINT test (#38)

## Objective

Make `apps/cli/test/serve.test.ts` › *starts next start, waits for health, opens the browser and
shuts down on SIGINT* pass deterministically on CI. Done when the test waits on a real readiness
signal or a named, generous timeout, and `pnpm test` passes with 100% coverage. Test-only change;
no retries, CI changes or threshold changes.

## Plan

Bug route of `om-auto-fix-issue`: triage → root cause → fix with a regression test → full gate →
PR → review loop.

## Decisions

- **Readiness event instead of a longer timeout.** `FakeProcess.running` resolves when `serve()`
  registers its SIGINT handler (EventEmitter `newListener`), and `whenRunning` awaits it. No
  polling interval or timeout is left to tune. If `serve()` never gets there, the test fails at
  Vitest's test timeout instead of a hidden 1 s poll.
- **Regression test with a slow startup.** A new test delays `checkPortFree` by 1200 ms, longer
  than `vi.waitFor`'s 1000 ms default. It adds ~1.2 s to the suite but is the only direct way to
  prove the helper no longer depends on startup speed.
- The issue was assigned to cieslinho; the maintainer approved a takeover, and an override
  comment was posted on #38 before the claim.

## Work performed

1. Triage: no open or closed PR and no commit on `main` references #38; `whenRunning` still used
   `vi.waitFor` with its default timeout.
2. Root cause from CI run 38928164282: `serve.test.ts` took 2821 ms while five other Vitest
   packages ran in parallel; the first, cold test exceeded the 1000 ms default before `serve()`
   registered SIGINT (after migrations, port check, runner start and health wait). Locally the
   test takes ~60 ms.
3. `apps/cli/test/serve.test.ts`: `FakeProcess.running`, event-driven `whenRunning`, regression
   test *waits for a startup slower than the default vi.waitFor timeout (#38)*.
4. Extended the lesson on testing processes with the `vi.waitFor` pitfall.

## Verification

- Regression test with the old polling helper restored: fails with the exact CI error,
  `AssertionError: expected +0 to be 1` (1021 ms). With the fix: passes (1205 ms).
- `apps/cli` serve tests: 20/20 pass.
- Full gate results are listed in the PR description.
- Not verified: a reproduction of the original flake under artificial CPU load (saturating the
  CPU was not allowed in this environment). The slow-startup test reproduces the same mechanism
  deterministically instead.

## Problems and deviations

None.

## Lessons recorded

- Updated [lessons/2026-10-14-testing-processes-and-http.md](../lessons/2026-10-14-testing-processes-and-http.md)
  and its index entry: `vi.waitFor` silently times out after 1 s; await a readiness signal.

## Follow-ups

- Other `vi.waitFor` calls in `serve.test.ts` (web.log content, web.log existence in `afterEach`)
  wait for fast file I/O after the slow startup has finished and have not failed on CI; left
  unchanged to keep the change focused.
