---
title: Categories page and category page (SPEC-124 Phase 2, issue #22)
date: 2026-11-05
agent: Claude Code / claude-opus-5-5
trigger: maintainer approved implementing SPEC-124 Phase 2 only (issue #22)
status: in-progress
branch: feat/category-pages
specs: [SPEC-124, SPEC-101, SPEC-106, SPEC-014]
---

# Run: Categories page and category page (SPEC-124 Phase 2)

Source doc: .ai/specs/2026-11-04-category-lifecycle-and-assignment.md

## Objective

Implement SPEC-124 §21 Phase 2 only, following the approved UI decisions in §11, §11.1 and §11.2
(D1 to D15): web schemas and messages, the create, update and archive Server Actions, the
`/categories` page (New category, Active, Archived), the new `/categories/[slug]` page with the
Archive confirmation panel, archived chips on `/artifacts` and the artifact page, the archived
option selected in the category filter, `MAX_SLUG_PARAM_LENGTH` from core, the two UD-5 doc
lines, and Playwright coverage. Phases 3 (assignment on the artifact page) and 4 (bulk) are out
of scope; issue #22 stays open (`Refs #22`).

## Plan

Goal: a user creates, renames, archives (after a confirmation with the count) and unarchives
categories in the app, and archived categories never show as active anywhere.

Scope: `apps/web/lib/categories.ts` (new), `apps/web/lib/actions.ts`, `apps/web/lib/artifacts.ts`,
`apps/web/app/categories/**`, `apps/web/app/artifacts/page.tsx`,
`apps/web/app/artifacts/[id]/page.tsx` (chips only), `apps/web/stories/patterns/risky-action.mdx`,
`apps/web/design-system.md`, `apps/web/test/**`, `apps/web/e2e/**`, SPEC-124 §20, SPEC-101
FR-101-10 status.

Non-goals: assign and remove on the artifact page (Phase 3); bulk assign and remove,
`listArtifactIds`, `setCategoryForListedArtifacts` (Phase 4); the other dash placeholders on
`/artifacts` (issue 123); new components, variants or tokens.

Risks: e2e tests share one database, so the new tests must leave predefined categories as they
found them (or use their own categories) and the existing `/categories` e2e test must follow the
new layout; a 64-character name in the confirm button at 320px (D11 implementer note).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Library and actions

- [ ] 1.1 `lib/categories.ts` schemas, messages and form state; tests
- [ ] 1.2 `createCategoryAction`, `updateCategoryAction`, `setCategoryArchivedAction`; tests
- [ ] 1.3 `MAX_SLUG_PARAM_LENGTH` from core; filter option helper; tests

### Phase 2: Pages

- [ ] 2.1 `/categories`: New category card, Active table, Archived card
- [ ] 2.2 `/categories/[slug]` with the Archive confirmation panel
- [ ] 2.3 Archived chips on `/artifacts` and the artifact page; archived option in the filter
- [ ] 2.4 UD-5 doc lines in `risky-action.mdx` and `design-system.md`

### Phase 3: Browser tests and docs

- [ ] 3.1 Playwright: categories flows, keyboard, 320px, contrast
- [ ] 3.2 SPEC-124 §20, SPEC-101 FR-101-10 status, run log

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
