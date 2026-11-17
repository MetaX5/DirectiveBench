---
title: Keep keyboard focus after a form submit on /repositories (issue 243)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: user request, om-auto-fix-issue 243
status: in-progress
branch: fix/issue-243-repositories-focus-after-submit
specs: [SPEC-104, SPEC-125]
---

# Run: Keep keyboard focus after a form submit on /repositories (issue 243)

## Objective

On `/repositories`, focus dropped to `<body>` after every server-action form (Register, Register
anyway, Scan, Cancel scan, Save branch, Remove repository). After each submit focus must land on
the action's result (its status line, the invalid field, the confirmation panel) using the focus
pattern `apps/web` already has, and the result must be announced. Playwright covers keyboard-only
Register and Scan at least; any `lib` change keeps 100% coverage.

## Plan

1. Red-first keyboard-only e2e tests: `apps/web/e2e/repositories-focus.spec.ts` (Register,
   invalid path, confirmation, Register anyway, Scan, Cancel scan, scan error, Remove, focus the
   user moved stays) and focus assertions in the Save branch test of
   `repository-branch.spec.ts`.
2. Root cause: each action redirects to `/repositories?...`; the App Router keys the page segment
   by its search params, so the page re-mounts and the focused control is gone. A job's result
   arrives by `AutoRefresh` re-render, which replaces the focused status line or re-enables a
   field. Next.js only scrolls to a fragment; it never moves focus (lesson 2026-11-16).
3. Fix in `app/repositories/` only (`lib/actions.ts` is off limits for this run): the result
   lines get `tabIndex={-1}` and `outline-none` (as `#branch-panel` and the blind-review result
   line already do), and a small client component focuses the result when it appears while focus
   is on `<body>`; an invalid field takes focus after an error (Form rule 3). Cancel in the
   register confirmation becomes a plain link to `#<Register button id>` (Risky-action rule 7).
4. Pattern docs, SPEC-104 and SPEC-125 notes, full gate, browser QA on 4398, Codex adversarial
   review, `om-auto-review-pr --autofix`, CI.

## Decisions

## Work performed

## Verification

Red first (on `main`'s code, the new tests only):

- `repositories-focus.spec.ts` "Register: focus goes to the status line": `expect(status).toBeFocused()`
  failed, `Received: inactive`.
- `repository-branch.spec.ts` "saving enqueues a branch change": `branch-status` not focused,
  `Received: inactive`.
- Scan (run alone after a registration): `expect(status).toBeFocused()` failed, `Received: inactive`.

## Problems and deviations

## Lessons recorded

## Follow-ups
