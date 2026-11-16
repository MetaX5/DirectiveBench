---
title: Repositories, Change branch in the Branch cell (issue 249)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: issue 249, option (d) approved by the maintainer on 2026-11-16 (issue comment)
status: partial
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

PR: #251

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Red-first test

- [x] 1.1 e2e test for the Branch cell Change control, one-line actions and focus — 04ce30b

### Phase 2: Implementation

- [x] 2.1 Move Change into the Branch cell and return Cancel focus to it — ecfad5b
- [x] 2.2 Update docs, stories and specs — 1042db9

### Phase 3: Verification

- [ ] 3.1 Full gate, real-app run and browser QA
- [ ] 3.2 Codex adversarial review and om-auto-review-pr

## Decisions

- Cancel is a plain `<a href="/repositories#change-branch-<id>">`, not `next/link`: with `Link`
  the issue 249 e2e test failed (Next only scrolls to the hash target; focus stayed on `<body>`),
  with `<a>` the page load focuses the button. The lesson on fragments and autofocus records it.
- The Button page gets an `XsInTableCell` story and names Change as the first `xs` use; the Form
  pattern's edit panel says Cancel returns to the control that opened it.
- The copy "Its branch was not changed: use Change branch in the list." (`lib/repositories.ts`,
  re-registration note) is unchanged: "Change branch" is still the control's accessible name.

## Work performed

1. Run log and draft PR #251 (7a9ce0c).
2. Red-first e2e test (04ce30b), see Verification.
3. Change in the Branch cell, `flex-nowrap` actions, Cancel to `#change-branch-<id>` (ecfad5b).
4. Docs, story, SPEC-104/SPEC-125 notes, lesson update (1042db9).

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass, 100% coverage in every package (6 of 7 tasks from the turbo cache) |
| `pnpm build` / `pnpm verify:pack` | pass |
| `pnpm test:e2e` | 189 passed |
| `pnpm test:storybook` | 68 files, 342 tests passed |

Red first on the old page (b3d89a5 page, new test): no Change button in the Branch cell (old
label "Change branch", size `sm`, in the actions cell), three buttons in the actions cell, Scan
and Remove on different lines at 1280px (y 1014 vs 1050), and after Cancel focus not on Change.
A first attempt with `next/link` for Cancel also failed the focus assertion.

Codex adversarial review round 1 (`--scope branch --base main`, target "branch diff against
main"): approve, no findings (static inspection only).

Browser QA on the built app (`test-env-up.sh`, port 4402, three seeded GitHub rows, no network,
Playwright Chromium): at 1280, 1440 and 320px in both themes Scan and Remove are on one line in
every hosted row, Change is 61x24px with a pointer cursor, local rows have no Change, no page
scroll at 320px, no console errors. Keyboard: Tab to Change, Enter opens the panel with the
Branch field focused, Tab Tab Enter on Cancel returns focus (`:focus-visible`) to the row's
Change button, in view; the next Tab reaches the row's Scan.

## Problems and deviations

**Stopped for a maintainer decision: visible deviation from the approved screenshots at 1280px.**
With the demo data the Bundled examples row has a long location (the install path), so the
Location column keeps its `max-w-md` floor (448px, lesson 2026-10-29). At 1280px the table is
then 59px wider than its container: the table scrolls sideways and Remove is cut off at the
right edge (`table-light-1280.png`). With the two-button actions cell switched back to
`flex-wrap` in the DOM (a simulation, not the old page) the same data still overflows by 2px. With a short location (`/opt/directivebench/examples`, set in the QA database only) the
table fits and matches the approved shots. At 1366 and 1440px it fits with either location. The
approved screenshots used only short locations. The cause is the Location column floor (issue
250, out of scope by the approval); the options are in the PR comment.

## Lessons recorded

- Updated [lessons/2026-11-16-a-fragment-target-blocks-autofocus.md](../lessons/2026-11-16-a-fragment-target-blocks-autofocus.md):
  a `next/link` to `#id` only scrolls; a plain `<a>` page load focuses the target.

## Follow-ups

- Maintainer decision on the 1280px overflow (PR #251 comment); then `om-auto-review-pr 251
  --autofix`, Codex re-review if code changes, and the ready flip.
- Issue 250 (Location column width) resolves the overflow at its root.
