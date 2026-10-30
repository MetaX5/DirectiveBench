---
title: SPEC-123 Phase 5, blind review of baseline and candidate outputs
date: 2026-10-30
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (om-auto-implement-spec, SPEC-123 §21 Phase 5 only), issue #152
status: in-progress
branch: feat/agent-run-output-files-blind-review
specs: [SPEC-123, SPEC-122, SPEC-014, SPEC-006, SPEC-008]
---

# Run: SPEC-123 Phase 5, blind review

Source doc: .ai/specs/2026-10-29-agent-run-output-files.md

## Objective

Implement **only** SPEC-123 §21 "Phase 5: Blind review" (§6.5, FR-123-50 to FR-123-55 with
FR-123-52a, §8.1 `0004`, §8.3 blind-review repository functions, §10 server actions, §11, §13,
§14, AC-7 and the blind-review part of AC-8). Phase 5 is the last phase of SPEC-123; the
maintainer approved it on 2026-10-30.

In scope:

- Migration `0004_blind_reviews.sql` (`blind_reviews`, `blind_review_pairs`) and the Drizzle
  schema; up/down test pinned to its journal prefix; cascade test.
- Repository functions in `@directivebench/database`: `startBlindReview` (one
  `withTransaction` whose first statement is the conditional `INSERT … ON CONFLICT DO NOTHING
  RETURNING`, random sides with `crypto.randomInt`, shuffled order, pair integrity asserted
  inside the transaction), `getBlindReviewForReviewer`, `getBlindPairFiles`,
  `hasUnrevealedBlindReview`, `recordBlindVerdict` (one conditional `UPDATE … RETURNING`),
  `revealBlindReview` (one conditional `UPDATE … RETURNING`), `getBlindReviewResult`, and the
  eligibility count the run page needs (A8).
- Server-side plumbing in `apps/web/lib`: `BLIND_REVIEW_NOTE_MAX_CHARS` and the shared Zod
  schemas, query parsing (`pair`, `path`), outcome messages (§13), the reveal summary sentence
  (FR-123-54), and the three server actions of §10.
- The `benchmark export` warning while a review is unrevealed (FR-123-52a; Phase 2 follow-up).
- After the UI decisions: the review page `/results/[id]/blind-review`, the run-page card,
  closing every labelled view while unrevealed (the "Output files" card and the "Agent runs"
  section of `/results/[id]`, the files page and the compare page, in HTML and RSC payload),
  the "Human blind review" summary next to the verdict, Playwright (flow, identification
  attempt, keyboard, 320 px, both themes, contrast).

Reused, not redesigned: `SideBySideDiff` variant `neutral` (D12; blind review passes no
`description`, D13), `FileView`, `FileStatusBadges`, `apps/web/lib/compare-files.ts` (#165) and
`highlightTexts` (#166, one job per render).

Not in scope: restarting or deleting a review, several reviewers, blind export (§19), any
change to score, verdict or display status (§4).

## Plan

Engine: om-auto-create-pr (steps: 9, --loop: no).

1. Migration `0004`, schema, migration and cascade tests.
2. Repository functions with tests (concurrency of two parallel starts, conditional verdict and
   reveal with a concurrent second call, unrevealed reads selecting no variant field asserted
   on the returned keys).
3. Web lib plumbing and server actions with unit tests at 100%.
4. `benchmark export` warning with a test.
5. Stop and return the UI decisions D46 and later (draft PR).
6. After the decisions: review page, run-page card and summary, closing of labelled views.
7. Playwright (flow, identification attempt on HTML and RSC payload, keyboard, 320 px, both
   themes, `ui-contrast`).
8. Gate, red-first proof, `directivebench demo` on the built app, browser QA agent, Codex
   adversarial review, `om-auto-review-pr` loop.
9. SPEC-123 §20 for verified behaviour only, run log, lessons.

## Decisions

### Decisions during plumbing

(filled in as the work proceeds)

## Work performed

1. Worktree `.ai/tmp/om-auto-create-pr/agent-run-output-files-blind-review-*` from
   `origin/main` (74f0cee), branch `feat/agent-run-output-files-blind-review`.

## Verification

Not run yet.

## Problems and deviations

None yet.

## Lessons recorded

None yet.

## Follow-ups

None yet.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Plumbing

- [ ] 1.1 Migration 0004 and schema
- [ ] 1.2 Blind-review repository functions
- [ ] 1.3 Web lib plumbing and server actions
- [ ] 1.4 Export warning
- [ ] 1.5 Return UI decisions D46 and later

### Phase 2: UI

- [ ] 2.1 Review page, run-page card and summary, closed labelled views
- [ ] 2.2 Playwright tests and contrast

### Phase 3: Verification

- [ ] 3.1 Full gate, red-first proof and real-app proof
- [ ] 3.2 Browser QA agent, Codex adversarial review and om-auto-review-pr
- [ ] 3.3 SPEC-123 §20, run log, lessons
