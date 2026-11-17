---
title: Overlap confirmation for a nested user-level agent folder (issue 244)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: issue 244, maintainer decision (option b) recorded on the issue
status: in-progress
branch: fix/issue-244-overlap-user-level-folder
specs: [SPEC-104, SPEC-102]
---

# Run: Overlap confirmation for a nested user-level agent folder (issue 244)

## Objective

The FR-104-18 overlap confirmation claimed that a nested user-level agent folder (for example
`~/.codex` inside a registered home directory) is already scanned by the outer repository and
counted twice. The scan skips those folders (D05, SPEC-102 §3), so the claim is false, in both
directions (registering the inner folder, or registering an outer folder that contains a
registered one). Fix the wording as the maintainer decided (option b) and write the rule in
SPEC-104 FR-104-18.

## Plan

1. Phase 1 (done earlier today): analysis, three options prototyped with screenshots; the
   maintainer chose option b and answered the open questions on the issue.
2. Spec: FR-104-18 and the §9 design note gain the rule; `userLevel` per overlap in the job result.
3. Red-first tests: runner (`registerLocalPath`: inside, contains, a location inside a user-level
   folder, `CLAUDE_CONFIG_DIR`), web lib (`confirmationReasons`: both sentences, both variants,
   ordinary message unchanged), database schema (the new optional field), Playwright (seeded job).
4. Code: the runner evaluates each overlap with `userLevelAgentFolders`, the scan's own skip
   list; the web picks the sentence.
5. Gate, real-app QA (server `HOME` at a fixture under `/var/tmp`), Codex adversarial review,
   `om-auto-review-pr`, CI. Follow-up issue for registering a user-level folder on its own.

## Decisions

- `userLevel` is `'folder' | 'inside-folder'`, absent for an ordinary overlap, so the web can say
  "inside a user-level agent folder" for a location such as `~/.claude/skills` (maintainer answer 3)
  and stored results written before this change stay valid.
- The flag is computed after the registration transaction: it changes only the wording, never
  whether a confirmation is asked, so it needs no transaction.

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
