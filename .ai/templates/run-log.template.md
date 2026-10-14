---
title: Short description of the run
date: YYYY-MM-DD
agent: tool and model (e.g. Claude Code / claude-opus-5-5)
trigger: who or what started the run (user request, issue, schedule)
status: completed        # in-progress | completed | partial | failed | aborted
branch: feature-branch-name
specs: [SPEC-NNN]        # specs read or changed
---

<!--
Save as .ai/runs/YYYY-MM-DD-<slug>.md (date the run started). One file per autonomous run.
Write facts, not intentions. Never include secrets, tokens or personal data.
-->

# Run: Short description

## Objective

What was asked, in one or two sentences, and the acceptance criteria used.

## Decisions

Significant decisions made without asking, with the reason. Link ADRs or specs that record them.

## Work performed

Ordered list of the main steps and the commits they produced.

## Verification

Commands that were run and their actual results (pass/fail counts). Say explicitly what was
not verified.

## Problems and deviations

Errors hit, how they were resolved, and anything that deviates from the specs.

## Lessons recorded

Links to entries added to `.ai/lessons.md` / `.ai/lessons/`.

## Follow-ups

Open items, known limitations and the recommended next task.
