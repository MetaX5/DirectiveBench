---
title: Issue 262, confirm registering a user-level agent folder on its own
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #262 (om-auto-fix-issue, maintainer decision 2026-11-19)
status: completed
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

- `userLevel` is computed by the runner before the transaction (a filesystem fact, using the
  scan's own `userLevelAgentFolders` through the existing `userLevelOf(location, location)`) and
  passed as a required `RegistrationConfirmationScope.userLevel`, so the ask/store decision stays
  in the registration transaction (SPEC-014) and no caller can forget it.
- The job result gains an optional top-level `userLevel` (`folder` | `inside-folder`, absent
  otherwise) so results stored before issue 262 still parse; the web shows the maintainer's fixed
  sentence for both values, first, before the overlap reasons.
- The form intro now also names user-level agent folders among the locations that ask first
  (consistency with FR-104-18; asserted in Playwright).
- Not changed: the QA observation that a confirmation panel stays when the path field is edited
  (pre-existing FR-104-18 behaviour, the panel names the location it registers; out of scope).

## Work performed

1. Red-first tests: runner (folder, inside a folder for every agent, `CLAUDE_CONFIG_DIR` /
   `CODEX_HOME`, symlinked folder, a project's own `.claude`, another user's folder, combined
   with an overlap), database (`registerLocalRepository`, result schema), web
   (`confirmationReasons`), Playwright (seeded jobs, Register anyway payload, 320 px).
2. Implementation in `packages/database/src/repositories/{catalog,jobs}.ts`,
   `packages/runner/src/repository-registration.ts`, `apps/web/lib/repositories.ts`,
   `apps/web/app/repositories/page.tsx`; test callers pass `userLevel: null`.
3. SPEC-104 FR-104-18, §9, §13 and implementation status; SPEC-102 §3 cross-reference.

## Verification

- Red first: runner 5 failed / 41 passed; database 4 failed / 59 passed; web 1 failed / 48
  passed. Green after the fix: 46/46, 63/63, 49/49.
- `pnpm lint`, `pnpm typecheck`: pass. `pnpm test`: pass, 100% coverage in every package.
  `pnpm build`, `pnpm verify:pack`: pass. `pnpm test:e2e` (port 4405): 206 passed (twice, before
  and after the copy change). `pnpm test:storybook`: 68 files, 342 tests passed.
- Built app, server `HOME` at a fixture under `/var/tmp`: registering `<home>/.claude` shows the
  confirmation and the repositories table holds no local row; after Register anyway it holds
  `<home>/.claude`; with `<home>` and `.claude` registered, `<home>/.claude/skills` shows the
  user-level reason first and both overlap reasons. Before (main build of 2026-11-13): the same
  registration said "Registered .claude" at once. No console errors, no horizontal overflow at
  320 px, both themes.
- Browser QA agent: no confirmed defects; contrast 17.82:1 / 14.20:1 text, 6.30:1 / 5.70:1
  Register anyway (hover 5.29:1 / 4.81:1).
- Codex adversarial review: see the PR's Review section.
- Not verified: Windows and macOS paths, real screen reader output, Firefox and WebKit.

## Problems and deviations

- The "before" screenshots come from the main checkout's existing build (2026-11-13), not a fresh
  build of `origin/main`; the standalone registration path did not change between them.

## Lessons recorded

- [2026-11-19-codex-review-cannot-run-the-gate-in-its-sandbox](../lessons/2026-11-19-codex-review-cannot-run-the-gate-in-its-sandbox.md)

## Follow-ups

- Copy nits from QA (maintainer's call): "This is a user-level agent folder" also for a location
  inside one, and the combined case repeats "finds no artifacts".
- A confirmation panel stays when the path field is edited afterwards (pre-existing).
