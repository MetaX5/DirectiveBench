---
title: Visible IDs for same-named suites and categories, unique per-row names (issues 227, 228)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issues 227 and 228 with UI decisions K1 to K9 approved 2026-11-16
status: completed
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

PR: #234

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Data

- [x] 1.1 Shared-name flags and suite slugs in the repositories — 58e863c, ad742bd

### Phase 2: Web

- [x] 2.1 PageHeader subtitle variant with stories and docs — c7ca5ca
- [x] 2.2 Naming helpers in lib with unit tests — c7ca5ca
- [x] 2.3 Pages: K1 to K9 and the extra scope — c7ca5ca, cb9dc7e, 65a9b01
- [x] 2.4 Playwright tests — 79a3406

### Phase 3: Specs and verification

- [x] 3.1 Spec updates — 455998c
- [x] 3.2 Quality gate, browser QA and screenshots — cb9dc7e
- [x] 3.3 Codex adversarial review and om-auto-review-pr — ad742bd

## Decisions

- "Shared" is global (any other row in the database), as K4 decided for suites; K9 follows the
  same rule for artifacts and K5 for chip text, so a row reads the same on every page. Each flag
  is a non-correlated `in (... group by ... having count(*) > 1)` in SQL (`packages/database/src/repositories/shared-names.ts`), so the
  web app never counts names per row; `listSuites` counts names in the repository because it
  already loads every suite.
- K5's "same chip text" compares the chip text, not the name: two archived "Platform" clash, and
  so does an active category named "Platform (archived)"; an archived and an active "Platform"
  do not ("(archived)" tells them apart).
- K1's bare ID under the name carries a screen-reader-only "ID " so it is read as "ID <id>".
- A same-named artifact's link in the Run card (K9) is named "<name>, slug <slug>", and a suite
  link whose name another suite has is named "<name>, ID <id>" (the approved extra scope).
- `/artifacts` Status link: "<status>, latest run of <artifact name>, slug <slug>"; `/results`
  Artifact link: "<artifact name>, run <run id>" (the only unique key a Results row has). Both
  start with their visible text.
- The PageHeader variant is a `subtitle` prop (a muted `text-ui` line between the h1 and the
  description), with two stories and docs (approved K2).
- Status labels moved from `components/common.tsx` to `lib/run-status.ts`
  (`DISPLAY_STATUS_LABELS`), so the Status link name repeats the badge text from one place.
- No new component for the ", ID x" fragment: Contributing requires maintainer approval for one,
  and the markup is one span per place.

## Work performed

1. `74394c0` execution plan; draft PR 234 opened.
2. `58e863c` database: `suiteNameShared`, `artifactNameShared`, `categoryChipShared`; slugs and
   flags in `listBenchmarkRuns`, `listArtifactRuns`, `listJobs`, `getArtifactDetail`,
   `listSuites`, `getSuiteDetail`, `listArtifacts`; `test/shared-names.test.ts`.
3. `c7ca5ca` web: K1 to K9 and the extra scope, `lib/row-names.ts` with tests, `PageHeader`
   subtitle with stories and docs, `design-system.md` row.
4. `79a3406` e2e: `disambiguation.spec.ts` with `disambiguation-seed.ts`; clash pages in
   `text-contrast.spec.ts`; exact artifact-link locators in `management.spec.ts` and
   `categories.spec.ts`; a chip keeps `break-all` unless it shows a clash slug.
5. `455998c` specs: SPEC-101 §11 and §20, SPEC-124 FR-124-14, D17, §14, §20, SPEC-116 §11 and §20,
   SPEC-114 §11 and §20.
6. `cb9dc7e` QA finding D1: a long suite ID wraps in the run facts (e2e red then green).
7. `65a9b01` K1: the ID breaks only at hyphens (`wrap-anywhere` let the table squeeze the Name column).
8. `ad742bd` Codex round 1 (needs-attention, medium): the correlated `exists` scanned the whole
   table per row (7.9 s for 1,000 categories and 100,000 assignments in Codex's reproduction).
   Each flag is now a non-correlated `in (values held more than once)`; a query-plan test fails
   on the old form (CORRELATED SCALAR SUBQUERY) and passes. Codex round 2: approve.

9. `009f4b5`, `8e73897` om-auto-review-pr (comment review, self-authored): approve, no blocker or
   major; nit fixed (issue numbers written as `#219` in web comments); nit left (the existing
   em-dash placeholders on `/executions`, issue 123). Manual QA instructions posted.

## Verification

Final gate on `ad742bd` (all with `TMPDIR=/var/tmp`):

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass, 100% lines, branches, functions and statements (core 320, database 320, agent-adapters 365 + 2 skipped, benchmark-engine 518, runner 290, cli 201, web 586) |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass ("Packaging verification passed") |
| `pnpm test:e2e` | 174 passed |
| `pnpm test:storybook` | 68 files, 326 tests passed (both themes, axe) |
| Red first | `disambiguation.spec.ts` against the old `apps/web/app` (built): 8 of 8 failed; the long-ID test failed at 610 px against 288 px before its fix; the query-plan test fails on the correlated form |

Real app: `sh .ai/scripts/test-env-up.sh` (port 4398, demo data, mock agent only) with the clashes
seeded through a copy of `disambiguation-seed.ts`; browser QA agent (agent-browser): accessible
names unique on every page, keyboard order and visible focus, no page overflow at 320 and 1280
in both themes, muted ID/slug contrast 6.01 (light) and 6.94/7.66 (dark), muted chip slug 5.51
and 5.86, no console messages. Screenshots: branch `qa-evidence-pr-234`, folder `pr-234/`.

Not verified: Cancel on `/executions` in the QA pass (no pending job in the demo data; covered
by the e2e test with held jobs); the no-clash case in the QA pass (covered by e2e).

## Problems and deviations

- QA D1: an 80-character suite ID without a hyphen (allowed by the schema) left the run page's
  card; fixed with `wrap-anywhere` and an e2e regression test.
- K1 at 1280px with the sidebar: with `wrap-anywhere` the ID split mid-word; it now breaks at
  hyphens only. The Mock agent badge on `/benchmarks` already wraps to two lines at 1280px on
  `main` (measured with the ID lines removed); not changed here.
- The new Status link name contains the artifact name, so locators that found the artifact link
  by a substring matched two links; they now ask for the exact name.

## Lessons recorded

None new: the findings are covered by existing lessons (QA agent, long words in grid cards,
e2e fixtures leave the database as found).

## Follow-ups

- QA G1: the artifact page's suite picker shows the name alone when the only other suite of
  that name is already assigned (I2 compares unassigned suites only).
- QA G2, G3: same-named artifacts are not told apart visibly on `/artifacts` (Name links),
  `/executions`, `/results`, the suite page Runs table and the run page (the decision document
  left this open).
