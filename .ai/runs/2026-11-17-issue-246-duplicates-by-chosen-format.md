---
title: Possible duplicates keyed on the chosen version's format (issue 246, option B)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: issue #246, maintainer decision of 2026-11-17 (option B)
status: in-progress
branch: fix/issue-246-duplicates-by-chosen-format
specs: [SPEC-126, SPEC-103, SPEC-101, SPEC-006]
---

# Run: Possible duplicates keyed on the chosen version's format (issue 246)

## Objective

After a revert to a version of another format (or the removal of the repository holding the
highest version), possible-duplicate groups keyed on `artifacts.type` plus the latest version's
format, so a same-named artifact of the on-disk format was not flagged. Option B: store the
chosen version's format as the source field `artifacts.format` (FR-126-07 / FR-103-16) and key
the groups on `(format, name)` with the index `artifacts_format_name_idx`.

## Plan

1. Specs first: SPEC-126 (FR-126-07, FR-126-11, A15, NFR-126-02, §8.1, G14, §20), SPEC-103
   (FR-103-16, §14 case 2, known limitation removed), SPEC-101 (§8.2, §8.3, FR-101-10), SPEC-006
   (§3.3).
2. Red-first database tests: the revert case in the list count and the detail card, the removal
   case, the migration `0009` backfill on a `0008` database, the query plan on the new index.
3. Code: schema column and index, migration `0009` (DDL plus a hand-written backfill), write
   paths `insertArtifact`, `importArtifactVersion`, `refreshSourceFields`; the grouped statement
   and the detail lookup read `artifacts.format`.
4. e2e raw-SQL seeds that expect a "Possible duplicate" Badge set `format`.
5. Separate commit: the PR #256 follow-up (share the representative-occurrence order).
6. Gate, real-app run (revert case, upgrade from a `main` database), Codex, om-auto-review-pr.

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
