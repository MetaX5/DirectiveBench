---
title: SPEC-125 Phase 2, repository removal (issue 21)
date: 2026-11-12
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (implement SPEC-125 Phase 2, decisions D12 to D26 approved)
status: in-progress
branch: feat/repository-removal
specs: [SPEC-125, SPEC-104, SPEC-006, SPEC-014]
---

# Run: SPEC-125 Phase 2, repository removal

Source doc: .ai/specs/2026-11-12-missing-occurrences-and-repository-removal.md

## Objective

Implement Phase 2 of SPEC-125 (issue 21, backlog E02-S03): a registered repository can be
removed from `/repositories` after the inline Risky-action panel states what is deleted and what
is kept; its occurrences are deleted, its artifacts and their history stay (missing when no other
repository has them). UI per the maintainer-approved decisions D12 to D26 (recorded as §11.3).
Acceptance criteria still open after Phase 1: AC-3, AC-7, AC-8, AC-9, AC-10. When all are
verified the spec moves to `implemented/` and the PR closes issue 21.

## Plan

Goal: remove a repository through one database transaction behind a server-rendered
confirmation, without touching files, processes or other data.

Scope: `packages/database` (`getRepositoryRemovalImpact`, `removeRepository`), `apps/web/lib`
(`canRemove`, `parseRemovalParams`, `removalReasons`, `removalResult`, the D23 suffix,
`removeRepositoryAction`), `apps/web/app/repositories/page.tsx` and the artifact page's
Occurrences card (D21), Storybook (D25), Playwright (D26), specs (SPEC-125 §11.3, §20, SPEC-104,
SPEC-006).

Non-goals: repository disable or edit, hosted cache deletion (issue 59), a CLI `repo remove`,
identical accessible names for same-named repositories (issue 215),
`/artifacts?repository=<removed id>` (issue 216), any npm release.

Risks: the removal deletes rows (cascade), so the conditional delete must refuse
`bundled-examples` and the counts must be read in the same transaction; the shared e2e database
must be left as found (lesson 2026-11-10).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Decisions

- [ ] 1.1 Record UI decisions D12 to D26 in SPEC-125 §11.3 and correct the spec text

### Phase 2: Database

- [ ] 2.1 getRepositoryRemovalImpact and removeRepository with tests

### Phase 3: Web

- [ ] 3.1 Web lib helpers and removeRepositoryAction with unit tests
- [ ] 3.2 Repositories page, Occurrences card and design-system docs
- [ ] 3.3 Playwright: removal flow, contrast and keyboard

### Phase 4: Verification and docs

- [ ] 4.1 Umbrella spec updates, SPEC-125 implementation status and move to implemented
- [ ] 4.2 Full gate, real-app run, browser QA, Codex review, run log

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
