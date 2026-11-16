---
title: Visible IDs for same-named suites and categories, unique per-row names (issues 227, 228)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issues 227 and 228 with UI decisions K1 to K9 approved 2026-11-16
status: in-progress
branch: feat/issues-227-228-disambiguation
specs: [SPEC-101, SPEC-124, SPEC-110, SPEC-109]
---

# Run: visible disambiguation and unique per-row names (issues 227, 228)

## Objective

Implement the approved decisions K1 to K9 and the extra scope from the approval comment on
issue 227 (same text on 228): show the suite ID where same-named suites must be told apart,
show the slug on chips of same-named archived categories and on same-named artifacts in the
suite page's Run card, and give every ambiguous per-row control a unique accessible name in
the #219/#220 format (", ID x", ", slug x", no parentheses).

Acceptance: the decisions as approved; unit tests for every naming helper and repository
change (100% coverage); Playwright tests that each row's control has a unique accessible name
and that the visible IDs appear; Storybook stories and docs for the new `PageHeader` variant;
specs updated in the same change set.

## Plan

Decision document (not committed): `.ai/tmp/issues-227-228-ui-decisions.md` in the main
checkout. Repository-side facts:

- `listBenchmarkRuns`, `listArtifactRuns`, `listJobs`, `getArtifactDetail` (suites) gain the
  suite slug and a `nameShared` flag computed in SQL (`exists` another suite with the name);
  `listSuites` gains `nameShared` (it loads every suite).
- `getSuiteDetail` assigned artifacts gain `nameShared` (another artifact has the name).
- Assigned categories (`listArtifacts`, `getArtifactDetail`) gain `chipShared` (another
  category shows the same chip text).
- Web: `PageHeader` gets an optional `subtitle` line (approved variant), naming helpers live in
  `lib/` with unit tests, status labels move to `lib/run-status.ts` so names can use them.

### Execution plan

Phase 1, data: shared-name flags in the database repositories with tests.
Phase 2, web: `PageHeader` subtitle variant with stories and docs; naming helpers; pages
(K1 to K9 and the extra scope); e2e tests.
Phase 3, specs and verification: SPEC-101, SPEC-124 and the suite/executions specs; quality
gate; browser QA; Codex review; om-auto-review-pr.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Data

- [ ] 1.1 Shared-name flags and suite slugs in the repositories

### Phase 2: Web

- [ ] 2.1 PageHeader subtitle variant with stories and docs
- [ ] 2.2 Naming helpers in lib with unit tests
- [ ] 2.3 Pages: K1 to K9 and the extra scope
- [ ] 2.4 Playwright tests

### Phase 3: Specs and verification

- [ ] 3.1 Spec updates
- [ ] 3.2 Quality gate, browser QA and screenshots
- [ ] 3.3 Codex adversarial review and om-auto-review-pr

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
