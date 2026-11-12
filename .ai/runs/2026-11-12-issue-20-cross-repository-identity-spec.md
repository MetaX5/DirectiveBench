---
title: Spec for issue 20 (the same skill in two repositories is one artifact)
date: 2026-11-12
agent: Claude Code / claude-opus-5-5
trigger: maintainer asked for the issue #20 (E02-S02) spec; om-auto-write-spec 20 (design only)
status: in-progress
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

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
