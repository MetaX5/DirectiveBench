---
title: Make code-span matching linear and fix the linear-time test
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: CI failure of the ratio test from PR #82 on PR #85
status: completed
branch: fix/markdown-ratio-test
specs: [SPEC-101, SPEC-007]
---

# Run: Make code-span matching linear and fix the linear-time test

## Objective

The ratio test added in PR #82 failed on PR #85 (`expected 1613.9 to be less than 1241.2`). Find
out whether it is noise or a real superlinear input, and fix the cause.

## Plan

Measure every input of the test at 25 000, 100 000 and 400 000 characters with coverage on.

## Decisions

- The runs-of-1…n-backticks input took 25.8 / 189.5 / 1497.5 ms: it grew with the size to the
  power 1.5, because `parseInline` searched to the end once per distinct run length, and there
  can be √(2N) of them. The module header claims every scan is linear, so this is a parser bug,
  not a test to loosen. The test bound stays at 8.
- Fix: on the first backtick, collect the starts of all maximal backtick runs per length once;
  each opener takes the first run of its length at or after its end, through a per-length cursor
  that only moves forward (openers come in increasing order). Results are unchanged.

## Work performed

- `apps/web/lib/markdown.ts`: `findClosingRun` replaces the per-opener forward scan.
- `apps/web/test/markdown.test.ts`: test for an escaped backtick splitting a run (the opener's
  length then need not exist as a run); comment on the backtick input.
- Lesson from PR #82 corrected: measure each input at three sizes before trusting a ratio.

## Verification

- Same input after the fix: 0.6 / 1.9 / 7.0 ms (was 25.8 / 189.5 / 1497.5 ms).
- The new and existing `markdown.test.ts` tests pass on the old parser too (25/25), so results
  are unchanged; `apps/web` tests: 153 passed, 100% coverage.
- `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`: all pass.

## Problems and deviations

The ratio test from PR #82 (this agent's) did not measure each input's growth first; on CI the
1.5-power input crossed the bound.

## Lessons recorded

- Updated [Timing tests must survive a loaded CI runner](../lessons/2026-10-21-timing-tests-must-survive-a-loaded-runner.md).

## Follow-ups

None.
