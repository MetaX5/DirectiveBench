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

- [x] 4.1 listArtifactIds and setCategoryForListedArtifacts in the database package, with tests — 224b40e
- [x] 4.2 setCategoryForListedArtifactsAction with filter re-parse and fingerprint guard, with tests — 792a9fe
- [x] 4.3 Bulk form on /artifacts per §11.4 (D28 to D37) — 2ab1930
- [x] 4.4 Archived category page without artifacts reads "No artifact has this category." (D38) — 2f8b941
- [x] 4.5 Design-system docs: Filtered list rule, BulkAction story, Checkbox rows (D39) — 379d970
- [x] 4.6 Playwright: bulk flows, list-changed after a scan, D28 sentences, keyboard, 320px, contrast — 8166148
- [x] 4.7 Spec status updates (SPEC-124 §20, SPEC-106 §20, SPEC-101 §20) — d9fa120

## Decisions

- **Bounded id scan and `too-many` reachability.** §8.2 asks to keep at most `limit + 1` ids and
  refuse a longer list as `list-changed`, while §15 asks for a `too-many` test with a lowered
  limit. `collectListedIds` keeps `limit + 1` ids and looks one match further without keeping it:
  exactly `limit + 1` with a matching fingerprint is `too-many`; more is `list-changed`, counted
  after the transaction. Both requirements hold; recorded in SPEC-124 §20.
- **Empty recomputed list is `list-changed`** ("now no artifacts"): the page never offers the
  action on an empty list (D28), so a post against one is stale or forged.
- **Ids are read in keyset batches** of `LISTED_ID_BATCH_SIZE = 1_000` rows ordered by name and id,
  so the bulk path's memory is bounded by the batch plus `limit + 1` ids; writes go in
  `IN` batches of `BULK_WRITE_BATCH_SIZE = 500`.
- **`idListFingerprint` lives in core** (`hash.ts`, "core hashing" in FR-124-13): SHA-256 of the
  ids sorted by UTF-16 code units, one per line.
- **The bulk form's state carries `categoryId`** (`BulkCategoryFormState`), as D30 requires; §10
  lists `MetadataFormState` for every action. The select is controlled, so React's form reset
  after an action cannot move it (lesson 2026-10-28).
- **Panel is its own form under the row**, holding the captured `categoryId`, `mode`, every list
  key and `listFingerprint` as hidden fields (D32); the row form has no submit control.

## Work performed

1. `docs(runs)` plan, draft PR #206 (6369913).
2. Step 4.1 `feat(database)` `listArtifactIds`, `setCategoryForListedArtifacts`,
   `MAX_BULK_CATEGORY_ARTIFACTS`, core `idListFingerprint`, `category-bulk.test.ts` (224b40e).
3. Step 4.2 `feat(web)` `bulkCategorySchema`/`parseBulkCategoryForm`, `parseArtifactListForm`,
   `artifactListFields`, `bulkCategoryState`, `bulkCategoryModel`,
   `setCategoryForListedArtifactsAction`, unit tests (792a9fe).
4. Step 4.3 `feat(web)` `app/artifacts/bulk-category-form.tsx` and the page wiring (2ab1930).
5. Step 4.4 `fix(web)` D38 copy (2f8b941).
6. Step 4.5 `docs(design-system)` D39 rule, `BulkAction` story, Checkbox rows (379d970).
7. Step 4.6 `test(web)` Playwright cases in `categories.spec.ts`.

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
