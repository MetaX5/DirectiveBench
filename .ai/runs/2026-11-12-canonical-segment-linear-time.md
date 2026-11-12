---
title: Linear-time trailing trim in canonicalSegment (CodeQL alert 9)
date: 2026-11-12
agent: Claude Code / claude-opus-5-5
trigger: user request (CodeQL code-scanning alert 9, js/polynomial-redos)
status: completed
branch: fix/canonical-segment-linear-time
specs: [SPEC-118]
---

# Run: Linear-time trailing trim in canonicalSegment

## Objective

Resolve CodeQL alert 9 (`js/polynomial-redos`, high) in
`packages/agent-adapters/src/claude-code/bundle-inspection.ts`: `canonicalSegment` trimmed
trailing dots and spaces with `/[. ]+$/`, which is quadratic on a long run of them that does not
end the string. Keep the behaviour of the SPEC-118 FR-118-26 pre-spawn inspection unchanged.

## Plan

1. Measure the regex to confirm the alert is real.
2. Red first: a linear-time test with `expectLinearTime`.
3. Replace the regex with one backward scan that returns the same value.
4. Quality gate, the linear-time test on 2 cores under load, lesson update, PR.

## Decisions

- Keep the exact old result, including its comparison with the original (not the NFKC-folded)
  segment: a segment of only dots and spaces stays as it is. Added edge cases (`. .`, `a . .`,
  `a . b`) pin it.
- No new path-length limit: the fix removes the superlinear cost itself; a length cap for hosted
  tree entry names would be a separate decision.

## Work performed

- Measured `' '.repeat(n) + 'x'` with the old regex: 5,000 → 8 ms, 10,000 → 32 ms,
  20,000 → 125 ms, 40,000 → 500 ms (quadratic).
- Test `runs in linear time on a long run of spaces that does not end the segment` in
  `packages/agent-adapters/test/claude-code/bundle-inspection.test.ts` (tails `x`, ` x`, `.x`).
- Backward scan in `canonicalSegment`.
- Lesson `2026-10-21-delimited-span-regex-must-exclude-its-opener.md` updated with the trailing-run
  shape.

## Verification

| Command | Result |
| --- | --- |
| New test before the fix | fail: ratio 31.9 (bound 3.5) |
| New test after the fix | pass |
| Same test with `taskset -c 0,1` and two `yes` processes | pass |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` (100% coverage) | pass: every package green |

Not run: `pnpm build`, `verify:pack`, e2e and Storybook (no app, packaging or UI change).
CodeQL closes the alert only after the PR merges and the scan of `main` runs.

## Problems and deviations

None.

## Lessons recorded

- Updated [`2026-10-21-delimited-span-regex-must-exclude-its-opener.md`](../lessons/2026-10-21-delimited-span-regex-must-exclude-its-opener.md).

## Follow-ups

- None required. A length limit on hosted tree entry names could be considered separately.
