---
title: Cancel in the Remove panel returns focus to Remove (issue 252)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: user request, om-auto-fix-issue 252
status: in-progress
branch: fix/issue-252-remove-cancel-focus
specs: [SPEC-125]
---

# Run: Cancel in the Remove panel returns focus to Remove (issue 252)

## Objective

On `/repositories`, Cancel in the Remove confirmation panel left focus on `<body>`. After Cancel,
focus (`:focus-visible`) must be on that row's Remove button, in view, and the next Tab must
continue after it. No visual change.

## Plan

1. Red-first keyboard-only e2e test in `apps/web/e2e/repositories.spec.ts`.
2. Give the row's Remove button `id="remove-repository-<id>"`; Cancel becomes a plain `<a>` to
   `/repositories#remove-repository-<id>` (same mechanism as the Change branch Cancel, issue 249).
3. Update the tests, pattern docs and SPEC-125 that encode the old `#repository-<id>` target.
4. Full gate, browser QA on port 4402, Codex adversarial review, `om-auto-review-pr --autofix`, CI.

## Decisions

- The row keeps `id="repository-<id>"`: nothing else needs it now, but removing it is outside the
  issue's scope and harmless to keep.
- The new e2e repository lives in its own temporary root, outside `sources`, so the FR-104-18
  test's count of contained repositories stays 3 (the first run inside `sources` broke it).
- The PR is opened as a draft (user constraint), so `om-open-pr`'s ready PR was done inline with
  the same labels and lock hand-off.

## Work performed

- `9bc3b58` test(web): the new e2e test (red on main).
- `8ec484c` fix(web): id on Remove, plain `<a>` Cancel, `missing-occurrences.spec.ts`
  expectation, risky-action pattern rule 7 and stories, SPEC-125 §11 and D19 notes.

## Verification

Red first: on main the new test failed at `await expect(remove).toBeFocused()` after Cancel
(`Received: inactive`); with the fix it passes.

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass, 100% lines/branches/functions/statements in every package (web 605 tests) |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass |
| `pnpm test:e2e` (port 4402) | 191 passed |
| `pnpm test:storybook` | 68 files, 342 tests passed |

Browser QA (Playwright Chromium, built CLI via `test-env-up.sh` on port 4402, demo data, mock
agent only, one local directory registered for the check): keyboard only, Tab to the row's
Remove, Enter opens the panel focused (`#remove-panel`), Tab reaches Remove repository then
Cancel, Enter: URL `/repositories#remove-repository-<id>`, the panel is gone, focus is on that
Remove with `:focus-visible` (2px solid outline), in view, pointer cursor, no horizontal page
scroll, in light and dark at 1280px and 320px. No console errors or warnings. Keyboard Remove →
Remove repository removes it and shows the result line (unchanged). Invalid URLs
(`#remove-repository-does-not-exist`, `?remove=does-not-exist`, `?remove=<script>`) render 200
without a panel. The next Tab after the last row's Remove leaves the page, as it does from a
plain focus there (Remove is the last focusable control); the e2e test checks the next Tab with a
row below.

Not verified: focus return in Firefox and Safari (Chromium only); contrast was not re-measured
(no colour or copy changed).

## Problems and deviations

- The first test title used single quotes around "row's" and broke the build (TS1005); fixed
  before the red run.

## Lessons recorded

None: the mechanism is already in `.ai/lessons/2026-11-16-a-fragment-target-blocks-autofocus.md`.

## Follow-ups

- Focus return after a page load is verified only in Chromium.
