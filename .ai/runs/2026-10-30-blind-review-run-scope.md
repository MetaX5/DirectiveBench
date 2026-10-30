---
title: Scope blind-review verdict and reveal to the benchmark run named in the form
date: 2026-10-30
agent: Claude Code / claude-opus-5-5
trigger: issue #170 (om-auto-fix-issue)
status: in-progress
branch: fix/blind-review-run-scope
specs: [SPEC-123, SPEC-014]
---

# Run: Scope blind-review verdict and reveal to the benchmark run named in the form

## Objective

Issue #170: `recordBlindVerdictAction` and `revealBlindReviewAction` parsed `benchmarkRunId` but
called `recordBlindVerdict(db, { pairId, verdict, note })` and `revealBlindReview(db, reviewId)`
without it, so a form posted with run A's id and run B's pair or review id changed run B's
review. Acceptance: both repository writes take the benchmark run id and match it in the same
conditional statement (SPEC-014); a mismatched run id is refused and changes nothing (red-first);
100% coverage; `blind-review` e2e green.

## Plan

1. Red-first tests: database (`packages/database/test/blind-reviews.test.ts`) and actions
   (`apps/web/test/actions.test.ts`) with two started reviews and crossed ids.
2. Add `benchmarkRunId` to both repository inputs and to the `WHERE` of the conditional write
   (the review subquery for verdicts, the review row for the reveal); the follow-up read reports
   the mismatch as a new outcome `other-run`, checked before `revealed` / `already-decided` /
   `already-revealed`.
3. Map `other-run` to user-facing error states in `apps/web/lib/blind-review.ts`; pass the parsed
   id from both actions.
4. E2E: forge the hidden `benchmarkRunId` on the review page and assert the messages and an
   unchanged database.
5. Update SPEC-123 §8.3, §10, §13 and §20; lesson; gate; Codex review; PR.

## Decisions

- A distinct outcome `other-run` instead of reusing `not-found`: the pair or review exists, so
  "no longer exists" would be wrong. New copy: "This pair belongs to another benchmark run." and
  "This review belongs to another benchmark run." (no en or em dash).
- The action still revalidates the posted run's path after a refusal, as it does for every other
  outcome; nothing changed, so the refresh is harmless and the code path stays uniform.

## Work performed

See the commits on `fix/blind-review-run-scope`.

## Verification

Red-first (before the fix, on f31c896 plus the new tests only):

- `packages/database`: `refuses a verdict or a reveal for a pair or review of another run and
  changes nothing (issue #170)` failed with `expected 'recorded' to be 'other-run'`.
- `apps/web`: the forged action posts returned `{ kind: 'success', message: 'Verdict recorded.' }`
  and `{ kind: 'success', message: 'Variants revealed. The blind review has ended.' }`, and run B's
  pair got `verdict: "a"` and its review a `revealedAt`.

After the fix: see the final section below.

## Problems and deviations

None so far.

## Lessons recorded

- [2026-10-30-scope-child-writes-by-the-posted-parent](../lessons/2026-10-30-scope-child-writes-by-the-posted-parent.md)

## Follow-ups

None.
