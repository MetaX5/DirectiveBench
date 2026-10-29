---
title: Move the API Key Mode live check from E06 to a new epic E07
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: maintainer request (no API key will be available for a while)
status: completed
branch: docs/move-api-key-live-check-to-e07
specs: [SPEC-118]
---

# Run: Move the API Key Mode live check from E06 to a new epic E07

## Objective

The maintainer decided on 2026-10-29 to move the API Key Mode half of SPEC-118 AC-22 (#103) out
of E06 (#93) into another epic, because no API key will be available for a while.

## Plan

Create a new epic, re-parent #103, update the E06 checklist, record the move in the backlog
file and SPEC-118 §20.

## Decisions

- New epic E07 (#147) rather than the parking epic E05 (#14): the work is concrete, has a spec
  and acceptance criteria, and only waits for a key.
- #103 renamed to E07-T01 (old id kept in its body and in `backlog.md`) and lowered from
  `priority-high` to `priority-low`, since it no longer blocks E06; it keeps `blocked`.
- #93 stays open: its "Done when" (a real Claude Code run against no baseline and against the
  previous version, both visible on the artifact page) is exercised by the D03 check the
  maintainer approved the same day; close it after that run.

## Work performed

- GitHub: created #147; edited #103 (title, parent, labels, comment); ticked the closed stories
  in #93 and added #117, which the checklist was missing.
- `.ai/specs/backlog.md`: E07 and E07-T01 rows, E06-S04-T01 row removed.
- SPEC-118 §20: API Key Mode tracked by E07 #147. AC-22 itself is unchanged.

## Verification

Docs and tracker only; no code changed. `pnpm format:check` run on the changed files.

## Problems and deviations

None.

## Lessons recorded

None: no correction or non-obvious constraint.

## Follow-ups

- Close #93 after the real D03 check run.
- #147/#103 when an API key is available.
