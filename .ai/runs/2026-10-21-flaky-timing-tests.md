---
title: Fix two timing tests that fail on loaded CI runners
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: user request (CI failed on main and on the first Dependabot PRs)
status: completed
branch: fix/flaky-timing-tests
specs: [SPEC-012]
---

# Run: Fix two timing tests that fail on loaded CI runners

## Objective

Make CI on `main` and on the Dependabot PRs #77–#79 green without weakening what the tests check.

## Plan

Find the failing tests in the CI logs, reproduce them, fix the cause in the tests.

## Decisions

- The grace-period test runs `sh -c "trap '' TERM; …"` instead of a Node.js script: the shell
  ignores SIGTERM right after it starts; the ignored disposition is inherited by `sleep`.
- The linear-time Markdown test compares each input at 25 000 and 100 000 characters (fastest of
  three runs, ratio below 8 + 50 ms) instead of a 5 s bound on the total. The old bound could not
  tell a slow runner from a regression: a quadratic pass over 100 000 characters takes a few
  seconds, close to the bound itself.

## Work performed

- CI logs: on `main` (runs 39658622182 and 39663761332) and on #77, #78, #79 the only failures
  were `commands.test.ts > … cancelled during the grace period` (`cancelled: false`,
  `signal: SIGTERM`) and `markdown.test.ts > parses pathological input in linear time`
  (`expected 5058.5 to be less than 5000`). #80 passed. The Dependabot changes themselves did not
  cause a failure: #77 changes only GitHub Actions versions.
- Fixed both tests; lesson recorded.

## Verification

- With the CPU saturated (`yes > /dev/null`, 3 × nproc processes) the old grace-period test failed
  2 of 5 runs; the new one passed 8 of 8. The new Markdown test passed 3 of 3 runs under load.
- `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`: all pass, coverage 100%.
- Not verified: that the new ratio test catches a real quadratic regression (none was injected).

## Problems and deviations

None.

## Lessons recorded

- [Timing tests must survive a loaded CI runner](../lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md)

## Follow-ups

- Re-run CI on the Dependabot PRs after this merges (`@dependabot rebase`).
