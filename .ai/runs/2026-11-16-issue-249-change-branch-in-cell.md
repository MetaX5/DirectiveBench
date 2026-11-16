---
title: Repositories, Change branch in the Branch cell (issue 249)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: issue 249, option (d) approved by the maintainer on 2026-11-16 (issue comment)
status: in-progress
branch: fix/issue-249-change-branch-in-cell
specs: [SPEC-104, SPEC-125, SPEC-014]
---

# Run: Repositories, Change branch in the Branch cell (issue 249)

## Objective

Since issue 58 each GitHub row on `/repositories` has three actions (Scan, Change branch,
Remove), which stack at the app's 72rem content width. Implement the approved option (d): the
Branch cell of a GitHub row shows the branch, its caption, then an `outline` `xs` **Change**
button (accessible name unchanged: "Change branch of <repository subject>") in the existing GET
form (`?changeBranch=<id>`, no fragment); the actions cell keeps Scan and Remove on one line
(`flex-nowrap`). Change opens the panel with the Branch field focused (as in issue 58); Cancel
returns focus to the row's Change button (`id="change-branch-<id>"`).

Acceptance criteria (issue 249 and the approval comment): hosted rows show Scan and Remove on
one line from 1280px inside the app; the Change control keeps the issue 58 behaviour and name;
button contrast in rest, hover and focus, pointer cursor, no en or em dash; an e2e test pins the
one-line actions and the accessible name; stories and the Button docs page updated; 100%
coverage holds.

## Plan

Source doc: `.ai/tmp/issue-249-decisions.md` (approved decision sheet, not committed) and the
approved screenshots in `.ai/tmp/issue-249-shots/`.

Non-goals: the Location column width (issue 250), the em dash placeholder of local-directory
rows (issue 123), the Remove panel's Cancel target, any change to the change panel itself.

1. Red first: a Playwright test in `apps/web/e2e/repository-branch.spec.ts` at 1280px that pins,
   for every hosted row, the Change button inside the Branch cell with its accessible name and
   visible label, Scan and Remove on one line, focus in the Branch field after Change, and focus
   on the row's Change button after Cancel. Record its failure on the old code.
2. `apps/web/app/repositories/page.tsx`: move the GET form into the Branch cell (`mt-1`,
   `Button variant="outline" size="xs"`, label "Change", `id="change-branch-<id>"`); actions
   cell `flex-nowrap`; the panel's Cancel links to `/repositories#change-branch-<id>`.
   Update the existing e2e expectations (`repositories.spec.ts` row text, branch cell text).
3. Docs: Button page names Change as the `xs` use; the Form pattern's edit-panel rule and story
   say Cancel returns to the control that opened the panel; SPEC-104 status lines; SPEC-125 D12
   note.
4. Gate, real-app check, browser QA, Codex adversarial review, `om-auto-review-pr`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Red-first test

- [ ] 1.1 e2e test for the Branch cell Change control, one-line actions and focus

### Phase 2: Implementation

- [ ] 2.1 Move Change into the Branch cell and return Cancel focus to it
- [ ] 2.2 Update docs, stories and specs

### Phase 3: Verification

- [ ] 3.1 Full gate, real-app run and browser QA
- [ ] 3.2 Codex adversarial review and om-auto-review-pr

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
