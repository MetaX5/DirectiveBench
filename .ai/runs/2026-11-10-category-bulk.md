---
title: Bulk assign and bulk remove of a category on the filtered Artifacts list (SPEC-124 Phase 4)
date: 2026-11-10
agent: Claude Code / claude-opus-5-5
trigger: maintainer request, run through om-auto-implement-spec (engine om-auto-create-pr)
status: in-progress
branch: feat/category-bulk
specs: [SPEC-124, SPEC-106, SPEC-101, SPEC-122, SPEC-014]
---

# Run: Bulk assign and bulk remove of a category on the filtered Artifacts list (SPEC-124 Phase 4)

Source doc: .ai/specs/2026-11-04-category-lifecycle-and-assignment.md

## Objective

Implement SPEC-124 §21 Phase 4: assign or remove one active category for every artifact the
applied filters list on `/artifacts`, after an inline Risky-action confirmation with the count,
guarded by a fingerprint of the listed ids and written in one transaction (FR-124-13, §8.2,
§8.3, §11.4 D27 to D39, §12 to §16, AC-8). Closes issue #22 (maintainer decision OQ-1).

## Plan

Goal: US-124-05 works end to end: filter to one repository, assign "Client A" to all listed
artifacts at once, and remove it again.

Scope: `packages/core/src/hash.ts` (list fingerprint), `packages/database/src/repositories/artifacts.ts`
(`listArtifactIds`, `setCategoryForListedArtifacts`, `MAX_BULK_CATEGORY_ARTIFACTS`, shared list
conditions), `apps/web/lib/{artifacts,categories,actions}.ts`, `apps/web/app/artifacts/page.tsx`
plus a new client component for the bulk row, `apps/web/app/categories/[slug]/page.tsx` (D38),
`apps/web/stories/patterns/filtered-list.{mdx,stories.tsx}` and the two design-system pages
(D39), unit tests, `apps/web/e2e/categories.spec.ts`, SPEC-124/106/101 status.

Non-goals: per-row checkboxes (UD-1), pagination (issue 53), extracting the shared `Messages`
copy (D39 follow-up), the other dash placeholders on `/artifacts` (issue 123), any file PR #203
changes (vitest configs, `vitest.shared.ts`, `test-support/temp-dir-guard.ts`, the runner and
CLI tests it touches, the testing-strategy spec).

Risks: the bulk write holds the write lock while `q` is matched in JavaScript (accepted, sized by
NFR-124-01); a `'use client'` file must not import core values (lesson 2026-11-05); React resets
uncontrolled forms after an action (lesson 2026-10-28), so the select is controlled.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 4: Bulk assign and remove on the Artifacts list

- [ ] 4.1 listArtifactIds and setCategoryForListedArtifacts in the database package, with tests
- [ ] 4.2 setCategoryForListedArtifactsAction with filter re-parse and fingerprint guard, with tests
- [ ] 4.3 Bulk form on /artifacts per §11.4 (D28 to D37)
- [ ] 4.4 Archived category page without artifacts reads "No artifact has this category." (D38)
- [ ] 4.5 Design-system docs: Filtered list rule, BulkAction story, Checkbox rows (D39)
- [ ] 4.6 Playwright: bulk flows, list-changed after a scan, D28 sentences, keyboard, 320px, contrast
- [ ] 4.7 Spec status updates (SPEC-124 §20, SPEC-106 §20, SPEC-101 §20)

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
