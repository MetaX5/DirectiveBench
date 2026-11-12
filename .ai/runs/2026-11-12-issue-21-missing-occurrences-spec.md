---
title: Spec for issue 21 (removed files marked missing, repository removal)
date: 2026-11-12
agent: Claude Code / claude-opus-5-5
trigger: maintainer picked issue #21 as the next feature; om-auto-write-spec 21 (design only)
status: completed
branch: docs/spec-issue-21-removed-occurrences
specs: [SPEC-125, SPEC-103, SPEC-104, SPEC-105, SPEC-101, SPEC-102, SPEC-124]
---

# Run: Spec for issue 21 (removed files marked missing, repository removal)

## Objective

Write a draft spec for issue #21 (E02-S03) covering its four acceptance criteria: a successful
rescan marks deleted files missing, history stays visible, repository removal deletes occurrences
but keeps artifacts and versions, and a failed scan marks nothing. Design only: no code, the
maintainer approves the spec before implementation.

## Plan

1. Read AGENTS.md, lessons, the specs index, issue #21, SPEC-103/104/105/101 and SPEC-124 (house
   model).
2. Verify the current code: `applyRepositoryScan`, `writeArtifactVersion`, discovery limits and
   errors, local and hosted scan failure paths, list and detail reads, the Repositories page.
3. Write SPEC-125 with autonomous defaults and UI decisions for the maintainer, phased.
4. Fresh-context staff-engineer review of the spec; apply real findings.
5. Open a design-only PR (`Refs #21`), then the Codex adversarial review until it approves.

## Decisions

- New SPEC-125 (next free id) refining SPEC-103/104/105 for this story, like SPEC-124.
- Every product choice is a default in §5a (A1 to A22) or §11.1 (UD-1 to UD-7); none needed
  `⚠ NEEDS HUMAN CONFIRMATION` because each is reversible and keeps history.
- Mockups and current-app screenshots were skipped: `agent-browser` is not installed and the
  worktree has no dependencies, so the test environment would need a cold install and build;
  the UI changes reuse existing components (muted Badge, `role="note"` line, the unchanged
  Risky-action panel). Text-only spec.

## Work performed

- Verified on main @ 0a922e0: nothing sets `artifact_occurrences.status = 'removed'`;
  `writeArtifactVersion` already reactivates by path; every per-scan limit (local
  `DiscoveryLimitError`; hosted cache limit, tree listing limit, `HOSTED_READ_TOTAL_BYTES`, text
  budget, timeouts) aborts before `applyRepositoryScan`; the job result cuts `errors` and
  `skippedUserLevelFolders`; `planCandidates` folds an unreadable directory inside a skill into
  that skill's `SKILL.md` error; `artifact_occurrences.repository_id` cascades and
  `artifact_versions.source_repository_id` is set null on repository delete.
- Wrote `.ai/specs/2026-11-12-missing-occurrences-and-repository-removal.md` (SPEC-125) and its
  index row; opened PR #213 (design only, `Refs #21`) with labels, the defaults comment on the PR
  and the issue; Codex adversarial review approved in round 1.

## Verification

| Check | Result |
| --- | --- |
| Spec-only change, no code | no quality gate needed; `.ai/` is outside Prettier |
| Fresh-context staff-engineer review | 1 critical, 1 high, 4 medium, 6 low; all applied (see below) |
| Dash check on proposed UI copy (§11, §13) | none |
| Codex adversarial review, round 1 (head 80b7404) | approve, no material findings |

Not verified: anything about implementation behaviour.

## Problems and deviations

- Staff-engineer review findings applied: unobserved paths now come from core's
  `DiscoveryResult` (an unreadable directory inside a skill was invisible in the error list, so
  a nested skill below it would have been marked missing); marking and display merged into one
  phase (two phases instead of three); "interrupted" wording fixed (an interrupted job can have
  committed); pending state dropped (it would need a client component); SPEC-104 contract and
  "cached clones are deleted" edits listed; branch-switch, classifier-change, scan-dedupe and
  overview-count edge cases added; complexity stated as O((n + u) log u); the URL-carried result
  accepted in §12; Cancel styled like Register anyway.

## Lessons recorded

None yet.

## Follow-ups

- After approval: `om-auto-implement-spec` phase by phase.
- Proposed follow-up issue: move and rename detection (FR-103-09) on top of the marking.
- Issue #59 (hosted cache deletion) and #53 (Show removed filter) stay open.
