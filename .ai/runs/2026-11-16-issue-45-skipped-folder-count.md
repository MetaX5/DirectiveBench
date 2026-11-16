---
title: Store the skipped user-level folder count and say "and N more" (issue 45)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: GitHub issue #45, UI decisions M1-M7 approved by the maintainer (option A for M3)
status: in-progress
branch: fix/issue-45-skipped-folder-count
specs: [SPEC-102, SPEC-104, database schema spec]
---

# Run: Store the skipped user-level folder count and say "and N more" (issue 45)

## Objective

A repository scan lists at most `MAX_SKIPPED_USER_LEVEL_FOLDERS` (50) skipped user-level
agent folders, so a `/home` scan with many users silently drops the rest. Store the total next
to the capped list and show "and N more" on the Repositories page, per the approved decisions
(issue #45 comment, 2026-11-16):

- M1: new result field `skippedUserLevelFolderCount` next to `skippedUserLevelFolders`.
- M2: optional in the Zod schema (no default); the page falls back to the list length; the
  runner always writes it (full count for local scans, 0 for GitHub scans); the page shows
  `max(0, count - list length)`.
- M3 (option A): append " and N more" before the final period of the existing sentence, N
  formatted with `formatCount`. No en/em dash.
- M4 to M6: same muted line, no new component; unchanged text when nothing is cut; no line when
  nothing is skipped; the "location is a user-level folder" sentence unchanged; plain sentence.
- M7: SPEC-102 status, SPEC-104 "Scan (issue #16)" bullet, database schema spec §3.11.

Acceptance: runner stores the total when a scan exceeds the cap; a legacy result without the
field parses; page message for 3/3, 50/51, 50/237, 50/1,250; GitHub scan writes 0; 100%
coverage; full quality gate, e2e and Storybook green.

## Plan

Non-goals: monospace folder paths, storing the full list, any other scan-result field, the
stale parts of §3.11 beyond bringing its shape up to date.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Tests first

- [ ] 1.1 Red tests for schema, runner (local and GitHub) and page message

### Phase 2: Implementation

- [ ] 2.1 Schema field, runner writes the count, page suffix
- [ ] 2.2 Specs SPEC-102, SPEC-104 and database schema §3.11

### Phase 3: Verification

- [ ] 3.1 Quality gate, e2e and Storybook
- [ ] 3.2 Browser QA on the built app with evidence
- [ ] 3.3 Codex adversarial review and om-auto-review-pr

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
