---
title: Database-wide suite picker clash rule and visible slugs for same-named artifacts (issues 235, 236)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issues 235 and 236 with UI decisions L1 to L7 approved 2026-11-16
status: in-progress
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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Data

- [ ] 1.1 Shared-name flags and artifact slugs in the repositories

### Phase 2: Web

- [ ] 2.1 Suite picker clash rule (L1)
- [ ] 2.2 Artifact slugs and link names on the lists and the run page (L2 to L7, hash label)
- [ ] 2.3 Playwright tests

### Phase 3: Specs and verification

- [ ] 3.1 Specs updated
- [ ] 3.2 Quality gate, browser QA, reviews

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
