---
title: Unique accessible names for same-named suites and categories (issues 219, 220)
date: 2026-11-13
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issues #219 and #220 with the approved UI decisions I1 to I10
status: completed
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

PR: #229

### Phase 1: Suites (issue 219)

- [x] 1.1 listSuiteNames returns slug, ordered by name then slug — e5600d4
- [x] 1.2 suiteSubject and suiteOptions helpers with unit tests — e609196
- [x] 1.3 Artifact page passes server-computed suite names to SuitesCard — e609196

### Phase 2: Categories (issue 220)

- [x] 2.1 categorySubject and chip removeName with unit tests — cd81741
- [x] 2.2 Artifact chip Remove and /categories count links use the subject — cd81741

### Phase 3: End-to-end tests

- [x] 3.1 Playwright test for same-named suites — 43081ca
- [x] 3.2 Playwright test for same-named categories (states A and B) — 43081ca

### Phase 4: Specs and docs

- [x] 4.1 SPEC-124, SPEC-101 and patterns/form.mdx text — a79eaa3

### Phase 5: Verification and review

- [x] 5.1 Full quality gate and red-first proof — 6ed5bc4
- [x] 5.2 Browser QA on the built app — 6ed5bc4
- [x] 5.3 Codex adversarial review until approve — 6ed5bc4
- [x] 5.4 Finalise run log

## Decisions

- Followed I1 to I10 as approved; no decision taken without the maintainer.
- I2 compares only the suites listed in the picker (the unassigned ones): once one of two
  same-named suites is assigned, the other's option is the name alone again. This is the E4
  pattern ("suffix only on a clash" among the options read together); the e2e test pins it.
- The I1 and I4 names are built on the server (`BenchmarksTab`, `categoriesCardModel`) and passed
  as props (`unassignName`, `removeName`, option `label`), because `metadata-forms.tsx` is a
  client component (lesson 2026-11-05).
- `listSuiteNames` orders a name tie by slug, so same-named options keep a stable order.

## Work performed

1. `e5600d4` feat(database): `listSuiteNames` returns `slug`, ordered by name then slug.
2. `e609196` fix(web): `suiteSubject` and `suiteOptions` in `lib/artifact-metadata.ts`;
   `BenchmarksTab` passes `unassignName` and option labels to `SuitesCard` (I1, I2).
3. `cd81741` fix(web): `categorySubject` in `lib/categories.ts`; chips carry `removeName`;
   `/categories` count links use the subject (I4, I5).
4. `43081ca` test(web): Playwright tests for same-named suites (`artifact-metadata.spec.ts`) and
   categories in states A and B (`categories.spec.ts`).
5. `a79eaa3` docs(specs): SPEC-124 D4, D17, §11, §14, §20; SPEC-101 §11 Suites;
   `patterns/form.mdx` rule 1 (I9).

## Verification

All on `6ed5bc4` with `TMPDIR=/var/tmp`:

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | 7/7 packages pass, 100% statements, branches, functions and lines each (web 579 tests, database 308) |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass |
| `pnpm test:e2e` | 164 passed |
| `pnpm test:storybook` | 68 files, 322 tests passed |

Red first:

- Database: with `benchmarks.ts` reverted, both `listSuiteNames` tests failed (no `slug`, and the
  name tie was not ordered by slug).
- Web unit: with `lib/artifact-metadata.ts` reverted, 3 tests failed (`suiteSubject` and
  `suiteOptions` not functions); with `lib/categories.ts` reverted, 3 failed (`categorySubject`
  missing, chips without `removeName`).
- E2E: with the three `apps/web/app` files reverted to `main` and the app rebuilt, both new tests
  failed: no button named `Unassign suite Input validation (mock agent demo), ID
  mock-input-validation` (exact), and no link named `1 artifact with Same Name E2E, slug
  same-name-e2e-2` (exact).

Real app: `sh .ai/scripts/test-env-up.sh` (built CLI, demo data, mock agent, 127.0.0.1:4398) and an
exploratory browser QA agent (agent-browser 0.35.2). It seeded two copies of the demo suite (SQL,
as the CLI imports no mock suite) and made the categories through the UI: picker options, three
Unassign names, keyboard assign and unassign (the database showed only the named suite
removed), states A and B for categories, names with parentheses and a comma ("Ops (legacy),
core") and 64 characters, both themes, 320px (no page scroll), console (clean). **No defects.**
Screenshots: branch `qa-evidence-pr-229`, folder `pr-229/`. Then `test-env-down.sh`.

Codex adversarial review (`--scope branch --base main`, target "branch diff against main") on
`6ed5bc4`: approve, no material findings.

Not verified:

- Screen-reader speech of "ID" and of the comma, and voice control.
- A plural count link ("2 artifacts with ..."): the demo has one artifact; the unit tests and
  the unchanged `artifactsPhrase` cover the phrase.

## Problems and deviations

- The first version of the suite e2e test selected the demo suite by its suffixed label after the
  copy was assigned; with one listed suite of the name the label is the name alone (I2 as
  designed), so the test was corrected, not the code.
- The QA agent noted that the result lines ("Removed Platform QA.", "Unassigned Input validation
  ...") do not say which of two same-named items changed. Decision I7 leaves this as is (focus and
  the remaining button's name make it clear); not changed.

## Lessons recorded

None: nothing non-obvious came up.

## Follow-ups

- #227: visible disambiguation of same-named suites and categories (I8.1).
- #228: per-row buttons named only by their verb (I8.2).
