---
title: Keep keyboard focus after a form submit on /repositories (issue 243)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: user request, om-auto-fix-issue 243
status: completed
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

- Stopped once after the prototype: Usage rule 7 said status lines "never take focus" and rule 2
  that focus is always visible, while the blind-review result line and `#branch-panel` take focus
  without a ring, and Usage rule 5 pointed to the control or the form's field. Options A1, A2, B
  and C went to the maintainer with screenshots (`.ai/tmp/issue-243-decisions.md`, not
  committed). **Maintainer decision: A1** (issue 243 comment
  https://github.com/MetaX5/DirectiveBench/issues/243#issuecomment-6950864392): the result line
  takes focus (`tabIndex=-1`, no ring); Usage rules 2 and 7 and Form rule 7 describe the
  exception.
- The focus logic lives in `app/repositories/take-focus.tsx` (a page-local client effect, no
  `lib` change, so no unit-coverage change): it focuses the target only while focus is on
  `<body>`, on mount and when `state` changes (Scan passes its notice kind so Cancel scan's
  disappearance re-focuses the status line).
- Cancel in the register confirmation became a plain `<a>` to `#register-repository`, the
  documented Risky-action mechanism (rule 8 added for a panel a job's result opens).
- The "Focus does not move to the first invalid field" gap on What is missing is closed.

## Work performed

- `4d49b1a` test(web): red-first e2e tests; `dad6937` this log; draft PR #254.
- `b0a07a5` fix(web): `TakeFocus`, ids and `tabIndex=-1` on the result lines, the Path field,
  the confirmation panel, Register and Cancel.
- `b4ac8c1` docs(web): Usage rules 2, 4, 7, Form rules 3 and 7, Risky-action rule 8 and story,
  What is missing, SPEC-104 §11, SPEC-125 D19 note, lesson.

## Verification

Red first (on `main`'s code, the new tests only):

- `repositories-focus.spec.ts` "Register: focus goes to the status line": `expect(status).toBeFocused()`
  failed, `Received: inactive`.
- `repository-branch.spec.ts` "saving enqueues a branch change": `branch-status` not focused,
  `Received: inactive`.
- Scan (run alone after a registration): `expect(status).toBeFocused()` failed, `Received: inactive`.


After the fix (gate on `b4ac8c1`, `TMPDIR=/var/tmp/issue-243-b`, e2e on port 4400):

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass, 100% lines/branches/functions/statements in every package (web 605 tests) |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass |
| `pnpm test:e2e` | 199 passed |
| `pnpm test:storybook` | 68 files, 342 tests passed |

Browser QA (Playwright Chromium script, built CLI via `test-env-up.sh` on port 4398, demo data,
mock agent only, light and dark at 1280px and 320px), keyboard only: Register → focus on
`p#registration-status` (`role="status"`, text "Registered …", in view), polled every 50 ms
while the runner checks (`data-state=active`) and focused throughout; invalid input (relative
path, a URL with credentials, `/`, a missing directory reported by the runner) → focus on the
Path field; overlapping path → focus on the confirmation panel (`role="alert"`), Cancel → Register
focused, Register anyway → status line focused; Scan → `p#scan-status` (`role="status"`, "Scanned
…") and the next Tab moves on into the table; Remove → panel focused, Remove repository →
`p#remove-result` ("Repository removed. …"). Crafted URLs (`?changeBranch=repo_nope`,
`?branchChangeError=not-found`, `?scanError=not-found`, `?removeError=failed`) focus their error
line; malformed ones (`?scan=nope`, `?remove=<script>` …) render 200 with nothing focused. No
horizontal page scroll, no console errors or warnings. No confirmed finding (an early "checking"
sample on `<body>` was the script reading before React committed; the 50 ms poll showed focus).

Not verified: Firefox and Safari (Chromium only); a real screen reader (checked only that the
focused element is the `role="status"`/`"alert"` line with readable text); Save branch and
Cancel scan in the QA script (no GitHub in QA, no held scan): both are covered by e2e with held
jobs; contrast not re-measured (no colour or copy changed).

## Problems and deviations

- The first plan targeted the result line without checking Usage rule 7; the conflict was found
  while writing the code and taken to the maintainer before anything else was pushed.
- The red proof for Scan ran the Scan test alone after a registration, because the serial
  describe stops after the first failing test.

## Lessons recorded

- [A server action's redirect re-mounts the page, and Next.js never moves focus](../lessons/2026-11-17-a-server-action-redirect-remounts-the-page.md)

## Follow-ups

- Other pages that redirect after a server action may drop focus the same way (`/benchmarks/[id]`
  run enqueue → `/executions`); not checked in this run.
