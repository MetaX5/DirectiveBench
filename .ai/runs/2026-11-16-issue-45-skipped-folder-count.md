---
title: Store the skipped user-level folder count and say "and N more" (issue 45)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: GitHub issue #45, UI decisions M1-M7 approved by the maintainer (option A for M3)
status: completed
branch: fix/issue-45-skipped-folder-count
specs: [SPEC-102, SPEC-104, database schema spec]
---

# Run: Store the skipped user-level folder count and say "and N more" (issue 45)

## Objective

A repository scan lists at most `MAX_SKIPPED_USER_LEVEL_FOLDERS` (50) skipped user-level
agent folders, so a `/home` scan with many users silently drops the rest. Store the total next
to the capped list and show "and N more" on the Repositories page, per the approved decisions
(issue #45 comment, 2026-11-16):

- M1: new result field `skippedUserLevelFolderCount` next to `skippedUserLevelFolders`.
- M2: optional in the Zod schema (no default); the page falls back to the list length; the
  runner always writes it (full count for local scans, 0 for GitHub scans); the page shows
  `max(0, count - list length)`.
- M3 (option A): append " and N more" before the final period of the existing sentence, N
  formatted with `formatCount`. No en/em dash.
- M4 to M6: same muted line, no new component; unchanged text when nothing is cut; no line when
  nothing is skipped; the "location is a user-level folder" sentence unchanged; plain sentence.
- M7: SPEC-102 status, SPEC-104 "Scan (issue #16)" bullet, database schema spec §3.11.

Acceptance: runner stores the total when a scan exceeds the cap; a legacy result without the
field parses; page message for 3/3, 50/51, 50/237, 50/1,250; GitHub scan writes 0; 100%
coverage; full quality gate, e2e and Storybook green.

## Plan

Non-goals: monospace folder paths, storing the full list, any other scan-result field, the
stale parts of §3.11 beyond bringing its shape up to date.

## Progress

PR: #241

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Tests first

- [x] 1.1 Red tests for schema, runner (local and GitHub) and page message — ec00d4e

### Phase 2: Implementation

- [x] 2.1 Schema field, runner writes the count, page suffix — ec00d4e
- [x] 2.2 Specs SPEC-102, SPEC-104 and database schema §3.11 — 39922e8

### Phase 3: Verification

- [x] 3.1 Quality gate, e2e and Storybook
- [x] 3.2 Browser QA on the built app with evidence
- [x] 3.3 Codex adversarial review and om-auto-review-pr

## Decisions

- No deviation from M1 to M7. `skippedUserLevelFolderCount` is `count.optional()`; the page uses
  `count ?? list.length` and `max(0, count - list.length)`.
- The temporary decision story (`.ai/tmp/issue-45-stories.patch`) is not committed: the change
  adds no component or variant, only a suffix to an existing sentence, and the Playwright test
  covers the rendered line (text and 320px overflow).
- e2e path: the e2e server's runner skips sibling-home folders of its own HOME only, so the
  test seeds completed `repository-scan` jobs as the runner stores them (capped with a total,
  and a legacy row without it) and removes them afterwards. The real runner path with more than
  50 folders is covered by the runner unit test and by the browser QA run below.

## Work performed

1. `packages/database`: `skippedUserLevelFolderCount` in `repositoryScanResultSchema`.
2. `packages/runner`: local scans write `discovery.skippedDirectories.length`; GitHub scans 0.
3. `apps/web/lib/repositories.ts`: `skippedFoldersInfo(folders, total)` appends
   ` and N more` (`formatCount`) before the period.
4. Tests: database (legacy row parses without the field, 237 parses, -1 and 1.5 rejected),
   runner (60 sibling homes: list of 50, count 60; existing D05 tests assert the count; hosted
   scan writes 0), web (3/3, 50/51, 50/237, 50/1,250, legacy, corrupt 3/1, `.`, empty), e2e.
5. Specs: SPEC-102 status, SPEC-104 scan bullet, database schema §3.11 result shape (also the
   SPEC-125/126 counters and `commitSha`, which it lacked).

## Verification

- Red first: before the implementation the new and extended tests failed: database 1, runner 5
  (4 local, 1 hosted), web 1 (the 50/51, 50/237 and 50/1,250 messages). All pass after it.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: pass.
- `pnpm test`: pass, 100% lines, branches, functions and statements in all 7 packages
  (database 321, runner 294, web 589 tests).
- `pnpm build`: pass. `pnpm verify:pack` (TMPDIR under `.ai/tmp`, removed): "Packaging
  verification passed".
- `pnpm test:e2e` (TMPDIR `/var/tmp/directivebench-e2e45`, removed): 180 passed, including the
  two new issue 45 tests.
- `pnpm test:storybook`: 68 files, 326 tests passed.
- Browser QA agent (agent-browser) on the built CLI (`test-env-up.sh`, port 4402, mock agent
  only) with `HOME` set to a fake home whose parent held 236 sibling homes: a real register and
  scan of the parent showed 50 folders "and 187 more."; home scan and user-level location
  unchanged; no overflow at 320 px; contrast 6.0:1 light, 6.9:1 dark; keyboard only works; no
  console messages. Evidence: PR comment, branch `qa-evidence-pr-241`.
- Not verified: an e2e test against the real runner with more than 50 skipped folders (needs
  control of the e2e server's HOME); a red run of the new e2e tests against the old build.

## Problems and deviations

- The first `pnpm test:e2e` used `TMPDIR` under `.ai/tmp` and 18 tests failed (registration
  tests found the repository's own work tree). This is the known constraint in
  `.ai/lessons/2026-10-30-keep-heavy-data-off-tmp.md` (TMPDIR must be outside every git work
  tree); rerun with `/var/tmp`, all 180 passed. No new lesson: the existing one covers it.

## Review

- Codex adversarial review round 1 (`--scope branch --base main`, head `41c21d3`): approve, no
  material findings.
- `om-auto-review-pr 241 --autofix` (engine `om-code-review`, head `41c21d3`, comment review
  since self-authored): approve, no findings; gate re-run on that head passed; manual QA
  instructions posted; labels `merge-queue`, `needs-qa`, `bug`, `priority-low`, `risk-low`.

## Lessons recorded

None new; the TMPDIR mistake is covered by `.ai/lessons/2026-10-30-keep-heavy-data-off-tmp.md`.

## Follow-ups

- QA observations outside this PR: focus drops to `<body>` after each form submit on
  /repositories; the overlap confirmation for a user-level folder inside a registered repository
  says "Its files are already scanned there" although such a location reads nothing; Register
  card copy still has em dashes (#123).
