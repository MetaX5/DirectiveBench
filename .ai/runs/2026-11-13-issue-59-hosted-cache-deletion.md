---
title: Delete a hosted repository's cache when the repository is removed (issue 59)
date: 2026-11-13
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issue #59 with decisions J1 to J14 approved on 2026-11-13
status: in-progress
branch: feat/issue-59-hosted-cache-deletion
specs: [SPEC-105, SPEC-104, SPEC-125, SPEC-010, SPEC-009, SPEC-014]
---

# Run: Delete a hosted repository's cache when the repository is removed (issue 59)

Source doc: `.ai/tmp/issue-59-decisions.md` (decisions J1 to J14, approved by the maintainer on
2026-11-13 in a comment on issue #59; the file is git-ignored, its content is summarised here and
in the PR).

## Objective

The runner deletes `<dataDir>/cache/repos/<id>.git` of a repository that no longer exists, in a
sweep at start and every 60 s (J1, J2), only when no row and no pending or running scan names the
id (J3), only for exact `repo_<16>.git` real directories under the canonical `repos` root (J4,
J5), with the scan's id check tightened to the same pattern (J6), logged per J7. `doctor` reports
orphans and entries DirectiveBench did not create (J8). The removal panel's hosted reason says the
copy is deleted (J9, J10). Spec edits per J12, tests per J13, one PR per J14. `Closes #59`.

## Plan

Goal: implement J1 to J14 exactly, no further scope.

Non-goals: no new job type or migration, no web file-system access, no change to
`removeRepository`, the success line, `/repositories` scan text or the README (J10, J11), no cache
sizes (J8 alternative a).

Risks: the J3 race test needs a hosted scan held mid-fetch (a wrapper git on `PATH` that waits for
a gate file before `fetch`); `doctor` must keep the database read-only.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Specs

- [x] 1.1 Amend SPEC-105, SPEC-104, SPEC-010, SPEC-009 and SPEC-125 per J12 — 34dfa37

### Phase 2: Database

- [x] 2.1 Add listOrphanedRepositoryCaches with tests — 0bc1ef7

### Phase 3: Runner

- [x] 3.1 Add hosted-cache.ts (pattern, listing, sweep) and tighten the hosted scan id check — d89b48e
- [x] 3.2 Sweep at runner start and on a timer, awaited by stop(), with the race test — 70b4178

### Phase 4: CLI

- [x] 4.1 Add the doctor hosted-cache check with tests — 6ca2491

### Phase 5: Web

- [x] 5.1 Change the hosted removal reason, story, unit and e2e tests — e365edc

### Phase 6: Verification

- [x] 6.1 Full quality gate, real CLI run and browser QA
- [x] 6.2 Codex adversarial review until approve
- [ ] 6.3 Implementation status, run log and PR

## Decisions

All behaviour follows the approved decisions J1 to J14; no decision was taken beyond them. Three
interpretations:

- J12 names "SPEC-010 §4" for the `doctor` row, but SPEC-010 §4 is "First run" and the `doctor`
  checks live in SPEC-009 (CLI architecture) §4. The `hosted-cache` check is specified there;
  SPEC-010 got the §5 `cache/` layout row and the §9 troubleshooting mention.
- J8 does not say whether `doctor` counts a cache with no row but a running scan as an orphan. It
  uses the same `listOrphanedRepositoryCaches` as the sweep, so such a cache counts as cached, not
  orphaned, until its scan ends (transient). `doctor`'s database read uses `withTransaction`
  (`BEGIN IMMEDIATE`) on the read-only connection; checked to work on a read-only and a WAL
  database with a writer open.
- `doctor` prints one `hosted-cache` check: orphans and unknown entries are joined in one `warn`
  line (details with "; ", hints with a space), so the check name stays unique in `--json`.

## Work performed

1. Specs (34dfa37): SPEC-105 FR-105-19 made concrete, §13 rows, §14 edge case, §15 tests;
   SPEC-104 FR-104-15; SPEC-010 §5 and §9; SPEC-009 §4; SPEC-125 dated notes (A14, FR-125-15,
   §11, D15, §4, §19, status).
2. `listOrphanedRepositoryCaches` in `packages/database/src/repositories/jobs.ts` (0bc1ef7).
3. `packages/runner/src/hosted-cache.ts`: `REPOSITORY_ID`, `REPOSITORY_CACHE_NAME`,
   `ORPHANED_CACHE_SWEEP_INTERVAL_MS`, `listRepositoryCaches`, `sweepOrphanedCaches`,
   `cacheErrorCode`; the hosted scan uses the strict `REPOSITORY_ID` (d89b48e).
4. `LocalRunner`: sweep after `recover()` (not awaited), 60 s timer, one at a time, `stop()`
   clears it and waits for a sweep in flight within its deadline (70b4178).
5. `doctor` `hosted-cache` check (6ca2491).
6. Removal panel copy, story, unit and e2e tests (e365edc).

## Verification

| Command (TMPDIR=/var/tmp) | Result |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test` | pass, 100% coverage; database 315, runner 290, cli 201, web 574, core 320, engine 518, adapters 365 (+2 skipped) |
| `pnpm build && pnpm verify:pack` | pass ("Packaging verification passed") |
| `pnpm test:e2e` | 163 passed, including the new issue 59 panel test |
| `pnpm test:storybook` | 68 files, 322 tests passed |

Red-first (each change reverted temporarily, the test failed, then restored):

- `listOrphanedRepositoryCaches` ignoring scan jobs: the J3 race test failed (the cache was
  deleted while the scan was running, `runner-cache-sweep.test.ts`).
- `stat` instead of `lstat` in the listing: 3 `hosted-cache.test.ts` tests failed (a symlink
  named like an id was treated as a cache; the `realpath` check still refused to delete it).
- `stop()` not waiting for the sweep: the stop test failed.
- The old `^[A-Za-z0-9_-]+$` id check: the J6 test failed.
- The new panel sentence: the unit test failed before `removalReasons` changed.

Real run (built CLI, data directory under `/var/tmp`, removed afterwards, mock only, a fake
failing `claude` first on `PATH`, no network):

- Planted `repos/repo_issue59LiveRow00.git` (row inserted), `repos/repo_issue59OrphanRow.git`
  (no row, with a link inside to a directory outside), `repos/notes` and a symlink
  `repos/repo_issue59SymlinkRw.git` to the outside directory. `doctor` before: `warn` "1 cached
  download belongs to a removed repository; 2 entries ... \"notes\", \"repo_issue59SymlinkRw.git\"".
- `serve --port 4402`: `runner.log` `cache-deleted` for the orphan at start; the live cache, the
  symlink, `notes` and the outside `keep.txt` survived. `doctor` after: only the 2 unknown entries.
- Deleted the live row with SQL while serving: deleted by the timer 53 s later (`cache-deleted`).
- Browser QA (agent-browser, demo data, a seeded `github` row with one occurrence and a cache):
  flow, keyboard, contrast 17.82:1 light and 14.20:1 dark, no overflow at 320 px in both themes,
  no console messages, invalid `?remove=` values; confirming the removal in the UI at 19:44:54
  was followed by `cache-deleted` at 19:45:06. No defects in this change. Side observations (em
  dashes elsewhere on `/repositories`, issue #123; the faint 1 px focus ring of the table scroll
  region) are outside this change.

Not verified: Windows and macOS file-system behaviour (J7 retries of `EBUSY`/`EPERM`), a real
github.com registration, scan and removal (needs network, deliberately not done), the `gitlab`
panel in the browser (unit-tested only), screen-reader speech.

Review rounds:

| Round | Verdict | Findings |
| --- | --- | --- |
| Browser QA agent (built app) | pass | No defects in the change |
| Codex adversarial 1 (`--scope branch --base main`) at e365edc | needs-attention | No material findings; only that its read-only sandbox could not run the gate (run here, all green) |
| Codex adversarial 2 (`--scope branch --base main`) at 512d052 | approve | No material findings |

## Problems and deviations

- A bash slip ran `git stash` mid-work; `git stash pop` restored it at once (untracked files were
  not stashed). No content was lost.
- No deviation from J1 to J14 beyond the interpretations under Decisions.

## Lessons recorded

None: nothing non-obvious was hit.

## Follow-ups

- Cache sizes in Settings (FR-105-19, J8 alternative a), later Settings work.
