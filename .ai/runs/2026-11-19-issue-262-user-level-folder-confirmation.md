---
title: Issue 262, confirm registering a user-level agent folder on its own
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #262 (om-auto-fix-issue, maintainer decision 2026-11-19)
status: in-progress
branch: fix/issue-262-user-level-folder-confirmation
specs: [SPEC-104, SPEC-102]
---

# Run: Issue 262, confirm registering a user-level agent folder on its own

## Objective

Registering a user-level agent folder (or a location inside one) on its own was stored
silently, although every scan skips it (D05). Maintainer decision: ask for an FR-104-18
confirmation ("Register anyway") with the fixed copy "This is a user-level agent folder. Every
scan skips user-level agent folders (scanning them is a planned opt-in), so registering it finds
no artifacts."; with an overlap reason (PR #261) both reasons are shown.

## Plan

1. Runner `registerLocalPath`: compute `userLevel` of the canonical location against its own
   scan's skip list (`userLevelAgentFolders`, the existing `userLevelOf(location, location)`).
2. Database `registerLocalRepository`: the scope carries `userLevel`; the ask/store decision in
   the transaction includes it; the outcome and the job result carry it.
3. Web `confirmationReasons`: one more reason with the fixed copy, before the overlap reasons.
4. SPEC-104 FR-104-18, §9, §13, implementation status.
5. Red-first tests: runner, database, web unit, Playwright with a seeded job.

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
