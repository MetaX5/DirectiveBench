---
title: Overlap confirmation for a nested user-level agent folder (issue 244)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: issue 244, maintainer decision (option b) recorded on the issue
status: completed
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
- After Codex round 1: an `inside` overlap also carries `readOnItsOwn: true` when the new
  location's own scan does not skip it (a sibling home's folder below a registered ancestor of the
  home directory). Its sentence drops "every scan skips it ... finds no artifacts" and says
  "a scan of that repository skips it, so nothing is counted twice". This wording was not part of
  the maintainer's decision: flagged in the PR for confirmation.

## Work performed

1. `093174f` docs(specs): FR-104-18 rule and §9 design note.
2. `cf4d611` merge of `origin/main` with PR #254 (issue 243 focus handling); no conflicts, focus
   behaviour untouched (checked in QA: the confirmation takes focus, Tab reaches Register anyway,
   Cancel returns focus to Register).
3. `2547353` fix: `repositoryOverlapSchema.userLevel`, `markUserLevelOverlaps` in
   `packages/runner/src/repository-registration.ts` (uses `userLevelAgentFolders`),
   `overlapReason` in `apps/web/lib/repositories.ts`; runner, database, web unit tests and a
   Playwright test that seeds finished registration jobs.
4. `5bc5b1d` fix after Codex round 1: `readOnItsOwn` for a sibling home's folder, spec updated.
5. Follow-up issue 262 filed with `om-prepare-issue` (registering a user-level folder on its own).
6. Spec implementation status, lesson, this log.

## Verification

- Red first (old code, new tests): runner 3 failed / 1 passed (the ordinary `.claude` test
  passes on both), web 1 failed, database 1 failed (schema rejected `userLevel`), Playwright
  1 failed (old build); after Codex round 1, the sibling-home runner test and the web test failed
  on the previous commit.
- Gate on `5bc5b1d` (TMPDIR under `/var/tmp`): `pnpm format:check` pass, `pnpm lint` pass,
  `pnpm typecheck` pass, `pnpm test` pass (100% coverage; runner 312, database 370, web 608 tests),
  `pnpm build` pass, `pnpm verify:pack` pass, `pnpm test:e2e` 200 passed (port 4400),
  `pnpm test:storybook` 342 passed.
- Real app (test env on 4398, mock agent, server `HOME` at fixtures under `/var/tmp`): case 2
  (register home containing a registered `.claude`), case 3 (ordinary nested, unchanged), case 4
  (`.codex` in a registered home), case 5 (`.claude/skills`, two "inside a user-level agent
  folder" reasons), case 6 (sibling home `users/bob/.claude` with `users` registered: new
  sentence; its own scan then found 1 artifact, confirming the Codex finding). Light and dark,
  1280 and 320 px, no horizontal overflow, no console errors or warnings, keyboard: Enter submits,
  Tab reaches Register anyway, Enter registers, Cancel returns focus to Register.
- Codex adversarial review: round 1 needs-attention (sibling home, medium, fixed); round 2 no
  material findings (verdict still needs-attention only because its read-only sandbox could not
  run the gate).
- Not verified: `CODEX_HOME`, `XDG_CONFIG_HOME` and symlinked dotfiles in the browser (the runner
  reuses the scan's list; `CLAUDE_CONFIG_DIR` is unit-tested); macOS and Windows.

## Problems and deviations

- The sibling-home sentence (`readOnItsOwn`) is new copy outside the maintainer's decision;
  flagged in the PR.

## Lessons recorded

- [The user-level skip list depends on the scanned location](../lessons/2026-11-17-user-level-skip-list-depends-on-the-scanned-location.md)

## Follow-ups

- Issue 262: registering a user-level agent folder on its own is stored silently.
