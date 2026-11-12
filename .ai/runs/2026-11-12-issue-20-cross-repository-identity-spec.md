---
title: Spec for issue 20 (the same skill in two repositories is one artifact)
date: 2026-11-12
agent: Claude Code / claude-opus-5-5
trigger: maintainer asked for the issue #20 (E02-S02) spec; om-auto-write-spec 20 (design only)
status: completed
branch: docs/spec-issue-20-cross-repository-identity
specs: [SPEC-126, SPEC-101, SPEC-103, SPEC-105, SPEC-104, SPEC-125, SPEC-124, SPEC-013, SPEC-006]
---

# Run: Spec for issue 20 (the same skill in two repositories is one artifact)

## Objective

Write a draft spec for issue #20 (E02-S02): identity rules 2 and 3 of SPEC-101 §8.3 for
repository content (moves within one scan, exact copies across locations), "possible
duplicate" hints for same-named artifacts with different content, and no slug matching for
repository content. Design only: no code; the maintainer approves the spec.

## Plan

1. Read AGENTS.md, lessons, the specs index, issue #20, epic #11, the brief and backlog,
   SPEC-101/103/104/105/125/124/013/006 and the identity code.
2. Write SPEC-126 with every open question answered by a recommended default.
3. Fresh-context review of the spec; apply real findings.
4. Commit, open a design-only PR (`Refs #20`), Codex adversarial review with
   `--scope branch --base main` until it approves, then `om-auto-review-pr` (COMMENT).

## Decisions

- New SPEC-126 (next free id) for the story, like SPEC-124 and SPEC-125; the umbrella specs are
  updated by the implementation PRs (§17 lists every requirement that changes).
- Every product choice is a default in §5a (A1 to A20) or §11.1 (UD-1 to UD-7) with the
  alternative; no `⚠ NEEDS HUMAN CONFIRMATION` marker, because the whole spec waits for the
  maintainer's approval and every default keeps history (no merge, no deletion).
- Mockups and current-app screenshots were skipped (text-only spec): the worktree has no
  dependencies and every UI point is to be approved in Storybook before code (§11).

## Work performed

- Verified on main @ db25447: scans use location identity only (`findArtifact` with
  `identity: 'location'`), rule 4 suffixes slugs, `writeArtifactVersion` overwrites `name` and
  `description` on every write, `artifact_versions` has no index on `content_hash` alone,
  `parsedMetadata` stores no name (only `frontmatter`), skill names fall back to the directory
  name, rule names are the file basename, repository-level formats are named by path, the
  SPEC-125 removal panel promises "Registering it again later creates new artifacts", and
  "Results by version" compares each version with the previous tested number
  (`apps/web/lib/artifact-runs.ts`).
- Wrote `.ai/specs/2026-11-12-cross-repository-artifact-identity.md` (SPEC-126) and its index row.
- Fresh-context staff-engineer review (subagent, read-only): 3 high, 4 medium, 3 low; all applied
  (name from the hashed bytes instead of `artifacts.name`, version lineage, write authority,
  exclusion per format, batched source-field read, full FR-103-09 / FR-105-16 (b) update, AC-3
  cases rule 3 cannot explain, no wall-clock NFR).
- Opened PR #218 (design only, `Refs #20`), labels `review`, `documentation`, `skip-qa`,
  `priority-medium`, `risk-low`, the label-rationale comment and the defaults comment on the PR and
  on issue #20.
- Codex adversarial review, `--scope branch --base main`, six rounds (heads f8a2eb3, 9149777,
  1801c29, 7ecc740, 4f2d2ba, e0189af): needs-attention five times, then approve. Fixes: only local
  repositories link (A16); creation-ancestry lineage with convergence and revert cases (FR-126-21);
  name and description derived from the active occurrences after every scan and every repository
  removal (FR-126-07, FR-126-23); fixed resolution order within a scan (FR-126-24); skipped files
  kept out of identity as they are out of versions and benchmarks (A20, after a per-occurrence
  guard leaked in rounds 2 and 3); accepted and tested limits A21 (edit copied before its source
  is rescanned) and A9 (name follows the latest version's scan order).
- `om-auto-review-pr 218`: specification review submitted as COMMENT (approve on the severity
  model: 3 minor, 1 nit). Fixed the minors as spec edits after it (skill parse path in FR-126-07,
  §6.1b for FR-126-23/24, the index rationale, this run log); FR-126-22 marked withdrawn.

## Verification

| Check | Result |
| --- | --- |
| Spec-only change, no code | no quality gate needed; `.ai/` is outside Prettier |
| `git diff --check main...HEAD` | clean |
| Dash check on proposed UI copy (§11) | none |
| Fresh-context review | 3 high, 4 medium, 3 low; applied |
| Codex adversarial review | approve in round 6 (e0189af) |
| `om-auto-review-pr 218` | COMMENT, no blocker or major |

Not verified: any implementation behaviour. The post-review edits (minors) were not re-reviewed by
Codex; they are editorial.

## Problems and deviations

- The first draft linked all types and compared `artifacts.name`; the fresh-context review showed
  both lead to false merges or order dependence (A2, A3).
- A per-occurrence skipped-file guard (FR-126-22) was added in Codex round 2 and withdrawn in
  round 4: each version of it leaked (first-observation metadata, upgrade nulls, order within a
  scan), and versioning already ignores skipped files.
- Mockups and screenshots skipped (text-only spec); UI points go through Storybook approval.

## Lessons recorded

None: no new constraint beyond the existing lessons (the Codex `--scope branch` lesson was
followed).

## Follow-ups

- After approval: `om-auto-implement-spec`, phase by phase.
- Proposed new issue: manual link and unlink between artifacts (merges pre-existing duplicates,
  repairs A21 splits).
- OQ-104-05 notice (A14).
