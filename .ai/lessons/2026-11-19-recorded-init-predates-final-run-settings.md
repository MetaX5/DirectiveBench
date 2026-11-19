---
title: The recorded 2.1.302 system/init predates the final run settings
date: 2026-11-19
tags: [claude-code, fixtures, evidence]
source: .ai/runs/2026-11-19-issue-257-reserved-skill-names.md
---

# The recorded 2.1.302 system/init predates the final run settings

## Context

Issue 257 needed the names Claude Code lists itself in a DirectiveBench run. The live recordings
`packages/agent-adapters/test/fixtures/claude-code/2.1.302/live-subscription-*.ndjson` list 21
`skills` (`code-review`, `simplify`, `deep-research`, …). They were committed together with
`disableBundledSkills: true` (commit `d36025e`) but come from sessions run before that setting
existed. With that setting the live check
saw only `design`, `doctor` and `plugin-authoring` besides the workspace skills (SPEC-203 §11).
Reserving all 21 would have refused common user skill names such as `code-review`.

## Lesson

A recorded fixture shows the settings of the session that produced it, not necessarily the
current argv. Before deriving a rule from a recording, check which run settings it was recorded
under (the spec's live-check notes and the git history of the fixture and of `argv.ts`).

## How to apply

- Take the skills a run lists from SPEC-203 §11's statement for the final settings; take the
  built-in slash commands from the recording's `slash_commands` minus its `skills`.
- When the live check is repeated for a newer `claude`, record it with the production argv and
  update `CLAUDE_RESERVED_SKILL_NAMES` and its documented version together.
