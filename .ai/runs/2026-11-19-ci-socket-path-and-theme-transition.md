---
title: Fix the socket path hang on macOS and the theme transition race in e2e contrast scans
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: maintainer request after CI failures on Dependabot PRs 268 and 269 (issue 270)
status: in-progress
branch: fix/issue-270-ci-socket-path-and-theme-transition
specs: []
---

# Run: Fix the socket path hang on macOS and the theme transition race in e2e contrast scans

## Objective

Fix two test-only CI failures (issue 270) without touching production code:
1. `packages/core` discovery and artifact-loader tests hang on the new macOS runner image
   because a Unix socket path exceeds the 104-byte `sun_path` limit.
2. `repository-branch.spec.ts` contrast scan flakes because it measures mid-transition colours
   after a theme switch.

Acceptance: red-first reproduction of both, green after, 100% coverage gate, full e2e run, and the
contrast test 30 times under CPU load with one worker.

## Plan

1. Replace the socket fixture with a FIFO (`mkfifo`, argv-only) in both core tests.
2. Disable transitions before contrast measurement after a theme switch; check the other specs.
3. Regression test for the race, gate, lesson, Codex adversarial review, draft PR, om-auto-review-pr.

## Decisions

- **The transition fix lives in `scanTextContrast` (`apps/web/e2e/contrast.ts`), not in each
  spec.** Ten spec files switch `colorScheme` and then call it (agent-run-files,
  artifacts-full-hd, blind-review, categories, compare-files, identity, missing-occurrences,
  repository-branch, text-contrast, versions). The scan disables transitions itself
  (idempotent `<style id="e2e-no-transitions">`), which cancels running ones, so every caller
  measures settled colours and no spec file changed. It is not a new helper; the existing
  measurement function now measures what it claims to.
- **New `apps/web/e2e/contrast.spec.ts` as the regression test**, in a new file so it cannot
  conflict with the issue 123 branch. It stretches every transition (600 s, `steps(1, end)`) and
  swaps the theme class, which makes the race certain instead of 1 in 30.
- The core tests were never skipped on Windows and CI has no Windows job, so no skip was added.
  `mkfifo` throws synchronously, so the fixture cannot hang.

## Work performed

See the PR commits.

## Verification

Filled in below after the gate.

## Problems and deviations

- The first regression test switched the theme with `emulateMedia` and passed without the fix:
  next-themes (`disableTransitionOnChange`) suppresses transitions during the class change, and
  the race needs a style recalculation after its 1 ms timer re-enables them. The test now
  swaps the class directly while transitions are stretched.
- The load run of the original test before the fix passed 30/30 (the race is about 1 in 30),
  so the deterministic regression test is the red-first proof for failure 2.

## Lessons recorded

- [2026-11-19 socket path limit and theme transition races](../lessons/2026-11-19-socket-path-limit-and-theme-transition-races.md)

## Follow-ups

- None from the excluded specs (`management`, `registry`, `repositories`,
  `results-by-version`): none of them measures colours after a theme switch.
