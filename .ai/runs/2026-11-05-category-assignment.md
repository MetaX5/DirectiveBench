---
title: Assign and remove categories on the artifact page (SPEC-124 Phase 3, issue #22)
date: 2026-11-05
agent: Claude Code / claude-opus-5-5
trigger: maintainer approved implementing SPEC-124 Phase 3 only (issue #22)
status: complete
branch: feat/category-assignment
specs: [SPEC-124, SPEC-101, SPEC-014]
---

# Run: Assign and remove categories on the artifact page (SPEC-124 Phase 3)

Source doc: .ai/specs/2026-11-04-category-lifecycle-and-assignment.md

## Objective

Implement SPEC-124 §21 Phase 3 only, following the approved UI decisions in §11, §11.2 and
§11.3 (D16 to D26): the §8.2 contract change (assign and unassign return `{ status, category }`
with the category read after the write; `ArtifactCategory` carries `id`), the
`assignArtifactCategoryAction` and `unassignArtifactCategoryAction` Server Actions with tests,
the Categories card on `/artifacts/[id]`, and Playwright for assign, remove, archived assignment
removable, focus, keyboard only, 320px and contrast in both themes. Phase 4 (bulk) is out of
scope; issue #22 stays open (`Refs #22`).

## Plan

Goal: a user assigns active categories to an artifact and removes assigned ones (archived
included) on the artifact page, with the copy and focus map of §11.3.

Scope: `packages/database/src/repositories/artifacts.ts` (outcome shapes, `ArtifactCategory.id`)
and its tests; `apps/web/lib/categories.ts` (schema, outcome-to-state mapping, card view model),
`apps/web/lib/actions.ts`; `apps/web/app/artifacts/[id]/page.tsx` and a client
`CategoriesCard` in `metadata-forms.tsx`; `apps/web/test/**`, `apps/web/e2e/**`; SPEC-124 §8.2
and §20, SPEC-101 status lines if touched.

Non-goals: bulk assign and remove, `listArtifactIds`, `setCategoryForListedArtifacts` (Phase 4);
links from chips (D18); new components, variants or tokens; other dash placeholders (issue 123).

Risks: e2e tests share one database, so new tests use their own categories and leave the demo
artifact's assignments as they found them; the existing `categories.spec.ts` finds archived
chips on the artifact page by text and must keep working once the chip moves into the new card;
a client card importing `lib/categories.ts` values would break `next build` (lesson 2026-11-05).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Repository contract

- [x] 1.1 Assign and unassign outcomes carry the category read after the write; `ArtifactCategory.id`; tests — a86cadb

### Phase 2: Library and actions

- [x] 2.1 `artifactCategorySchema`, outcome-to-state mapping and card view model; tests — b4b57f3
- [x] 2.2 `assignArtifactCategoryAction`, `unassignArtifactCategoryAction`; tests — b4b57f3, 02eacbc

### Phase 3: Artifact page

- [x] 3.1 Categories card on `/artifacts/[id]` (D16 to D26) — a437bd2

### Phase 4: Browser tests and docs

- [x] 4.1 Playwright: assign, remove, archived removable, focus, keyboard, 320px, contrast — a437bd2
- [x] 4.2 SPEC-124 §8.2 and §20, run log — fc72319, 92dfb33

## Decisions

- The D25 focus map is one fallback chain: the select; else, after an assign, the assigned
  chip's Remove; after a remove, the Remove now at the removed chip's place; else the last
  chip's Remove; else the "Categories page" link. A refused assign without a picker (a stale
  page) therefore lands on the last chip or the link, which D25 does not name explicitly.
- The pending line follows the pressed button through an `onSubmit` state, since the action
  runs after the pending render.

## Work performed

- Session 1 (2026-11-05): a86cadb (repository outcomes carry the category read after the
  write, `ArtifactCategory.id`), b4b57f3 (`artifactCategorySchema`, `assignCategoryState`,
  `unassignCategoryState`, `categoriesCardModel`, the two Server Actions, unit tests). The
  Progress checkboxes were not ticked in that session; they were checked against the code on
  2026-11-10.
- Session 2 (2026-11-10, resumed with `om-auto-continue-pr 198`): 02eacbc fixes a `pnpm
  typecheck` failure the b4b57f3 test introduced (an array of forged forms inferred as a union
  not assignable to `Record<string, string>`); a437bd2 adds `CategoriesCard` in
  `metadata-forms.tsx` (types only from `lib/categories.ts`, model computed on the server), moves
  categories out of the Metadata card and adds nine Playwright tests to `categories.spec.ts`;
  SPEC-124 §20 and SPEC-101 §20 updated.
- Review (`om-auto-review-pr 198 --autofix`, COMMENT review): two minors fixed in 7761446 (D24
  pending lines untested; D21/D22 sentences not contrast-scanned).
- QA (`om-auto-qa-pr 198`, agent-browser on the built app after `demo`): PASS, 9 steps (assign,
  remove, archived chip removal, dark theme, 320px, forged hidden id, console). Screenshots
  stay local (`.ai/qa/artifacts_pr198/` in the main checkout); no `qa-evidence-*` branch.
- Codex adversarial review: round 1 found the picker loading `listCategories` (an aggregate over
  `artifact_categories`) on every Overview load, fixed with `listActiveCategoryNames` (ba3db69);
  round 2 found that an unarchive between the no-op insert and the explaining read gave
  "already-assigned" without an assignment, fixed first with a bounded retry (38abe02); round 3
  found the exhausted retry reporting an active category as archived, so 92dfb33 replaced the
  retry with one `withTransaction` (`assignArtifactCategory` now takes the handle); round 4
  flagged "No categories yet." and the D21 sentence as unspecified copy, declined: both are
  verbatim in SPEC-124 §11; round 5, given that citation, approved with no findings.

## Verification

| Command (head 92dfb33, TMPDIR under /var/tmp) | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass, 100% lines, branches, functions, statements in every package |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass |
| `pnpm test:e2e` | 128 passed |
| `pnpm test:storybook` | 304 passed |

Red-first proofs: the D25 "Remove that took its place" test fails with an off-by-one in the
focus fallback; the pending-line test fails with a fixed "Assigning…"; the transaction test
fails with the `withTransaction` wrapper removed (statements outside a transaction).

## Problems and deviations

- b4b57f3 (session 1) left `pnpm typecheck` failing; fixed in 02eacbc.
- `assignArtifactCategory(db, …)` became `assignArtifactCategory(handle, …)` (SPEC-124 §8.2
  updated): the race fix needs `withTransaction`.

## Lessons recorded

- [Explain a no-op conditional write inside the same transaction](../lessons/2026-11-10-explain-a-no-op-write-in-its-transaction.md)

## Not verified

- QA ran on 7761446, before the database changes of ba3db69 and 92dfb33 (no UI change since);
  the e2e suite covers the card on the final head.
- A real concurrent archive from a second process during an assign is argued from
  `BEGIN IMMEDIATE`, not reproduced (one writable connection per test thread, lesson
  2026-11-04); the test proves every statement runs inside the transaction.

## Follow-ups

- SPEC-124 Phase 4 (bulk assign and remove on the Artifacts list); issue #22 stays open.
