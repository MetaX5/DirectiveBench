---
title: Delete a hosted repository's cache when the repository is removed (issue 59)
date: 2026-11-13
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issue #59 with decisions J1 to J14 approved on 2026-11-13
status: in-progress
branch: feat/issue-59-hosted-cache-deletion
specs: [SPEC-105, SPEC-104, SPEC-125, SPEC-010, SPEC-009, SPEC-014]
---

# Run: Delete a hosted repository's cache when the repository is removed (issue 59)

Source doc: `.ai/tmp/issue-59-decisions.md` (decisions J1 to J14, approved by the maintainer on
2026-11-13 in a comment on issue #59; the file is git-ignored, its content is summarised here and
in the PR).

## Objective

The runner deletes `<dataDir>/cache/repos/<id>.git` of a repository that no longer exists, in a
sweep at start and every 60 s (J1, J2), only when no row and no pending or running scan names the
id (J3), only for exact `repo_<16>.git` real directories under the canonical `repos` root (J4,
J5), with the scan's id check tightened to the same pattern (J6), logged per J7. `doctor` reports
orphans and entries DirectiveBench did not create (J8). The removal panel's hosted reason says the
copy is deleted (J9, J10). Spec edits per J12, tests per J13, one PR per J14. `Closes #59`.

## Plan

Goal: implement J1 to J14 exactly, no further scope.

Non-goals: no new job type or migration, no web file-system access, no change to
`removeRepository`, the success line, `/repositories` scan text or the README (J10, J11), no cache
sizes (J8 alternative a).

Risks: the J3 race test needs a hosted scan held mid-fetch (a wrapper git on `PATH` that waits for
a gate file before `fetch`); `doctor` must keep the database read-only.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Specs

- [ ] 1.1 Amend SPEC-105, SPEC-104, SPEC-010, SPEC-009 and SPEC-125 per J12

### Phase 2: Database

- [ ] 2.1 Add listOrphanedRepositoryCaches with tests

### Phase 3: Runner

- [ ] 3.1 Add hosted-cache.ts (pattern, listing, sweep) and tighten the hosted scan id check
- [ ] 3.2 Sweep at runner start and on a timer, awaited by stop(), with the race test

### Phase 4: CLI

- [ ] 4.1 Add the doctor hosted-cache check with tests

### Phase 5: Web

- [ ] 5.1 Change the hosted removal reason, story, unit and e2e tests

### Phase 6: Verification

- [ ] 6.1 Full quality gate, real CLI run and browser QA
- [ ] 6.2 Codex adversarial review until approve
- [ ] 6.3 Implementation status, run log and PR

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
