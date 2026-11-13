---
title: Unique accessible names for same-named suites and categories (issues 219, 220)
date: 2026-11-13
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issues #219 and #220 with the approved UI decisions I1 to I10
status: in-progress
branch: fix/issues-219-220-unique-names
specs: [SPEC-124, SPEC-101]
---

# Run: Unique accessible names for same-named suites and categories (issues 219, 220)

## Objective

Close #219 and #220 per the maintainer-approved decisions I1 to I10 (approved 2026-11-13 in
comments on both issues; prepared in `.ai/tmp/issues-219-220-ui-decisions.md`, not committed).
Acceptance criteria:

- I1: every Unassign on the artifact page's Assigned benchmarks card is named
  `Unassign suite <name>, ID <slug>`; visible text stays "Unassign".
- I2: the suite picker lists the name alone, plus `, ID <slug>` only when two listed suites share
  a name; `listSuiteNames` also returns `slug`, ordered by name then slug.
- I4: every category chip's Remove is named `Remove category <chip text>, slug <slug>`.
- I5: every count link on `/categories` is named `<N artifacts> with <chip text>, slug <slug>`
  ("(archived)" in the Archived table).
- I3, I6, I7: no change. I8: follow-ups #227 and #228, out of scope.
- I9: SPEC-124 (D4, D17, §11, §14, §20), SPEC-101 §11 Suites and Storybook `patterns/form.mdx`.
- I10: unit tests at 100% coverage, Playwright tests for both category states and same-named
  suites, red-first proof. No visible change.

## Plan

Goal: give every per-row control named from a suite or category name a name that is unique on
the page, by adding the unique key (suite ID, category slug) after a comma.

Scope: `apps/web/lib/artifact-metadata.ts` (`suiteSubject`, `suiteOptions`),
`apps/web/lib/categories.ts` (`categorySubject`, `removeName` on chips),
`apps/web/app/artifacts/[id]/page.tsx` and `metadata-forms.tsx` (names computed on the server),
`apps/web/app/categories/page.tsx`, `packages/database` `listSuiteNames`, tests, specs and the
Storybook docs page.

Non-goals: visible disambiguation (#227), verb-only per-row buttons on other pages (#228), the
suite links (I3), the `/categories` name links (I6), other category controls (I7).

Risks: the client component must not import core values (lesson 2026-11-05), so every name is
computed on the server; e2e seeds must leave the shared database as found.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Suites (issue 219)

- [ ] 1.1 listSuiteNames returns slug, ordered by name then slug
- [ ] 1.2 suiteSubject and suiteOptions helpers with unit tests
- [ ] 1.3 Artifact page passes server-computed suite names to SuitesCard

### Phase 2: Categories (issue 220)

- [ ] 2.1 categorySubject and chip removeName with unit tests
- [ ] 2.2 Artifact chip Remove and /categories count links use the subject

### Phase 3: End-to-end tests

- [ ] 3.1 Playwright test for same-named suites
- [ ] 3.2 Playwright test for same-named categories (states A and B)

### Phase 4: Specs and docs

- [ ] 4.1 SPEC-124, SPEC-101 and patterns/form.mdx text

### Phase 5: Verification and review

- [ ] 5.1 Full quality gate and red-first proof
- [ ] 5.2 Browser QA on the built app
- [ ] 5.3 Codex adversarial review until approve
- [ ] 5.4 Finalise run log

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups

- #227: visible disambiguation of same-named suites and categories (I8.1).
- #228: per-row buttons named only by their verb (I8.2).
