---
title: Database-wide suite picker clash rule and visible slugs for same-named artifacts (issues 235, 236)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issues 235 and 236 with UI decisions L1 to L7 approved 2026-11-16
status: completed
branch: feat/issues-235-236-artifact-disambiguation
specs: [SPEC-101, SPEC-116, SPEC-114]
---

# Run: same-named artifacts and the suite picker (issues 235, 236)

## Objective

Implement the approved decisions L1 to L7 and the added "hash" label from the approval comment
on issue 236 (same text on 235):

- L1 (#235): the artifact page's suite picker adds ", ID x" to an option whenever any other suite
  in the database has the same name (the K4 rule), through `listSuiteNames().nameShared`.
- L2 to L5 (#236): `/artifacts` Name, `/results` Artifact, `/executions` Artifact and the suite
  page's Runs table add a muted ", slug x" when another artifact (any type, whole database) has
  the same name.
- L6: the run page's "Artifact version" fact always shows ", slug x"; the title is unchanged.
- L7: on a clash the `/artifacts` Name link is named "<name>, slug <slug>" and the `/results`
  Artifact link "<name>, slug <slug>, run <run id>"; otherwise unchanged.
- Run page: the content hashes in the artifact and suite version facts get a visible muted
  "hash" label.

Out of scope: issue 237 (where an artifact lives).

Acceptance: decisions as approved; unit tests for every repository and naming change (100%
coverage); Playwright tests for every new UI path, red on the old pages; specs updated in the
same change set.

## Plan

Decision document (not committed): `.ai/tmp/issues-235-236-ui-decisions.md` in the main
checkout. Data-layer additions, all additive and computed in SQL with the set-based
`artifactNameShared` / `suiteNameShared` flags from `shared-names.ts`:

- `listSuiteNames` gains `nameShared`; `suiteOptions` uses it instead of counting the
  unassigned options.
- `listArtifacts` gains `nameShared`.
- `listBenchmarkRuns` artifacts gain `slug` and `nameShared`.
- `JobListItem` gains `artifactSlug` and `artifactNameShared`.

### Execution plan

Phase 1, data: the repository fields with tests (including the query-plan test for the new
flags). Phase 2, web: naming helpers, the five surfaces and the run page facts, e2e tests.
Phase 3, specs and verification: SPEC-101, SPEC-116, SPEC-114; quality gate; browser QA; Codex
review; om-auto-review-pr.

## Progress

PR: #238

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Data

- [x] 1.1 Shared-name flags and artifact slugs in the repositories — 92d7c6f

### Phase 2: Web

- [x] 2.1 Suite picker clash rule (L1) — 48c90b7
- [x] 2.2 Artifact slugs and link names on the lists and the run page (L2 to L7, hash label) — b49cc6c, 99012bb, c3ee17a
- [x] 2.3 Playwright tests — db2b1d8

### Phase 3: Specs and verification

- [x] 3.1 Specs updated — e6cfaf3
- [x] 3.2 Quality gate, browser QA, reviews — 96a17fa

## Decisions

- The suffix markup stays inline on each page, as PR 234 did for K3 to K9, instead of a new
  shared component: it is one span, and a new design-system component would need its own
  stories and page (AGENTS.md: three similar lines beat a premature helper). The draft decision
  stories are not committed; the pages are server components without stories, as in PR 234.
- `artifactLinkName` (row-names) names a link by "<name>, slug <slug>" on a clash, mirroring
  `suiteLinkName`; the suite page's Run card (K9) now uses it too. `resultRunName` takes the
  artifact instead of its name.
- The run page's hash label is a small local `ContentHash` component in the run page file
  (two uses, same file).
- `listArtifacts` selects every artifact column plus the flag (`getTableColumns`), so the flag
  rides on the existing statement; no new query per row.

## Work performed

1. `897eee2` plan commit; draft PR 238 opened.
2. `92d7c6f` database: `listSuiteNames().nameShared`; `ArtifactListItem.nameShared`;
   `BenchmarkRunListItem.artifact.slug` and `nameShared`; `JobListItem.artifactSlug` and
   `artifactNameShared`; tests in `shared-names.test.ts` (including the query-plan test for the
   new statements) and the updated list tests.
3. `48c90b7` web L1: `suiteOptions` uses `nameShared`.
4. `b49cc6c` web L2 to L7 and the hash label: `artifactLinkName`, `resultRunName(artifact, runId)`,
   the five surfaces and the run facts' `ContentHash`.
5. `db2b1d8` e2e: four new tests in `disambiguation.spec.ts`.
6. `e6cfaf3` specs: SPEC-101, SPEC-116, SPEC-114.
7. `99012bb` `listJobs` flags the listed artifacts in one statement, not one per job (the
   Executions page refreshes every 2 s and artifacts can be many).
8. `c3ee17a` e2e updates: the issue 219 picker test now expects the L1 rule, and
   `registry.spec.ts` finds rows by the link's visible text (the two scanned `AGENTS.md`
   artifacts now have slug-qualified link names) and checks those names.
9. `96a17fa` QA finding F1: the suite page Run card's artifact link is underlined at rest.

## Verification

Gate (all with `TMPDIR=/var/tmp`):

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass, 100% lines, branches, functions and statements in all 7 packages (database 321 tests) |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass ("Packaging verification passed") |
| `pnpm test:e2e` | 178 passed (first run: 2 failed, an old-rule picker test and an exact-name locator, both updated; rerun after the `listJobs` change) |
| `pnpm test:storybook` | 68 files, 326 tests passed |
| `disambiguation.spec.ts`, `text-contrast.spec.ts`, `management.spec.ts` after F1 | 27 passed |
| Red first | the four new tests against the old `apps/web/app` and `lib` (built): 4 of 4 failed, the 9 existing passed; the F1 underline check failed ("none") before the fix |

Real app: `sh .ai/scripts/test-env-up.sh` (port 4398, demo data, mock agent only); two local
repositories with a root `AGENTS.md` each, registered and scanned on the Repositories page; the
demo suite assigned to both and run from the suite page (mock runs); a same-named suite copy
seeded as a row copy (the CLI imports no mock suite). Browser QA agent (agent-browser): L1 to L6
and the hash label pass in both themes at 1280 and 320 px; no page overflow at 320 px; muted
suffix and label contrast 6.01:1 (light) and 6.94:1 (dark) on cards; link names unique per page;
keyboard-only assign and unassign; no console messages; axe 0 violations on the changed pages
(one existing minor one on `/executions`: an empty header cell). Screenshots: branch
`qa-evidence-pr-238`, folder `pr-238/`.

Codex adversarial review round 1 (head `96a17fa`): approve, no findings.

om-auto-review-pr (engine om-code-review, head `81a011e`, comment review since self-authored):
approve; gate re-run on that head (format, lint, typecheck, test, build, verify:pack) all pass;
two nits left as follow-ups (the existing em-dash placeholder on `/executions`, issue 123; the
colour-and-weight distinction of the `/artifacts` and `/results` links). Manual QA instructions
posted.

Not verified: the screenshots predate the F1 fix (the Run card is covered by the e2e test);
the native picker's open option list cannot be captured headless (option texts were read and
are asserted in e2e).

## Problems and deviations

- No deviation from L1 to L7. Extra: F1 (WCAG 1.4.1) on the K9 Run card link, fixed here
  because this PR touches that link.
- `/artifacts` and `/results` links differ from the muted suffix in dark by colour and weight
  (500 against 400), not by underline; axe passes them; left as is, matching the approved
  mock-ups.

## Lessons recorded

None new: the e2e locator breakage after an accessible-name change is covered by PR 234's run
log and the existing QA and contrast lessons.

## Follow-ups

- QA observation: the artifact page's "Assigned …" and "Unassigned …" status lines name the
  suite by name only, so with two same-named suites they do not say which one.
- Issue 237 (where an artifact lives) stays separate.
