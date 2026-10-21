---
title: Hosted scan and registration fail safely on cache filesystem errors (issue #57)
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: issue #57 (follow-up of PR #51), om-auto-fix-issue bug route
status: completed
branch: fix/issue-57-cache-error-status
specs: [SPEC-104, SPEC-105]
---

# Run: Hosted scan and registration fail safely on cache filesystem errors

## Objective

A filesystem error on DirectiveBench's own cache (`<dataDir>/cache/…`: permission denied, disk
full, a failed `mkdir`, `chmod`, `rm`, `lstat` or `readdir`) must end a hosted registration or
scan job with a fixed, safe message, and a scan must set the repository's `sync_status` to
`error`. A cancelled job stays `cancelled`/`interrupted`. Acceptance criteria of #57: the fixed
message and `sync_status = 'error'` for a cache that cannot be created, read or removed, with a
regression test without network.

## Plan

1. Audit every fs call on the hosted path (registration, clone, fetch, reads, cleanup, size
   watch) — `packages/runner/src/{hosted-git,hosted-repository,git-process}.ts`.
2. Fix the root cause once, at the boundary all hosted git and cache steps pass through, instead
   of per call site; keep cancellation first.
3. Close the fail-open spots found by the audit.
4. Regression tests for each failure point (real permissions where they work, injected fs
   failures where they cannot), proven red without the fix.
5. Spec wording (SPEC-105 §13 and §20, SPEC-104 §20), lesson, full gate, real CLI check.

## Root cause and failure points

`scanHostedRepository` and `registerHostedUrl` only handled typed `HostedGitFailure` results;
every fs call threw straight to `LocalRunner.execute`, whose generic catch stored
`error.message` (`EACCES: permission denied, mkdir '/abs/…'`) as the job error, and
`markRepositoryScanFailed` never ran. Failure points found:

| Where | Call | Before |
| --- | --- | --- |
| registration and scan, `prepare` | `mkdir`/`chmod` of `cache`, `cache/git-home`, `cache/repos` | raw message escaped; scan status unchanged |
| step 1, `fetchSnapshot` | `lstat` of the repository cache | any error meant "absent: clone" (fail open) |
| step 1, `fetchSnapshot` | `rm` after a failed fetch or clone | raw message escaped |
| step 1, `finishDownload` | `directorySize` after the download, `chmod` of the new cache | raw message escaped |
| steps 1 and 4, size watch | `directorySize` while git downloads | `git clone failed: The running check failed: EACCES: permission denied, scandir '<cache>/…'` (raw system text) |
| size measurement | `lstat` of each file | any error counted the file as 0 bytes (fail open) |
| steps 2/4/5, `drop` | `rm` of the cache after a failed step | raw message escaped |
| step 4, `fetchBlobs` | `directorySize` after the blob fetch | raw message escaped |
| every git step | spawn error | `spawn /usr/bin/git ENOENT` (git's absolute path; a missing cwd looks the same) |
| any of the above after cancellation | — | reported as a failure instead of `cancelled`/`interrupted` |

## Decisions

- One boundary, `onCacheError` in `hosted-repository.ts`, wraps the git and cache steps of both
  jobs (registration: `prepare` + `ls-remote`; scan: steps 1–5 in the new `fetchCandidates`).
  It rethrows `GitCancelledError`, turns any error after the signal fired into a cancellation,
  and otherwise returns `cacheFailure(error)`: `git-failed` with `DirectiveBench could not use
  its cache of hosted repositories in the data directory (<code>). Check that the data
  directory is writable and the disk has free space.` The scan records it via
  `markRepositoryScanFailed`, like every other hosted failure.
- ⚠️ Decision needed: the code is the existing `git-failed` (as for the existing data-directory
  refusal in `prepare`) rather than a new `cache-failed` code, so no `jobs.result` enum changes
  (most reversible). A dedicated code can be added later.
- Fail closed: only `ENOENT` means "absent" (`absentAs`), in `fetchSnapshot` and
  `directorySize`; a size check that fails during a download stops git and is thrown as a cache
  error instead of being formatted as git's error.
- Messages name only the errno code (`errnoCode`, a `^[A-Z][A-Z0-9_]{0,31}$` token, else
  `unknown error`), never the error text.
- After a cache error no extra deletion is attempted: the deletion is usually what failed; the
  next scan's fetch-or-clone path handles a leftover cache.

## Work performed

- `packages/runner/src/git-process.ts`: `errnoCode`; spawn and watch errors carry only the code.
- `packages/runner/src/hosted-git.ts`: `cacheFailure`, `absentAs`; `runStep` rethrows a failed
  size check; `fetchSnapshot`/`directorySize` fail closed.
- `packages/runner/src/hosted-repository.ts`: `onCacheError`, `fetchCandidates` (steps 1–5
  return failures, the caller records them once).
- Tests: new `packages/runner/test/hosted-repository-cache-errors.test.ts` (12 tests: read-only
  parent, a file in place of `cache`/`cache/repos`, a per-repository cache that git cannot write
  and `rm` cannot empty, injected `mkdir`/`chmod`/`lstat`/`readdir`/`rm` failures, the size watch
  with a fake git that keeps downloading, cancellation and shutdown before a cache error, the
  `LocalRunner` end to end); updated `hosted-git.test.ts` and `git-process.test.ts`.
- SPEC-105 §13 row and §20 status; SPEC-104 §20 registration line; lesson
  `2026-10-21-simulate-errors-the-code-cannot-repair`.

## Verification

- Red first: with the `src` changes stashed, all 12 new tests fail; with them, they pass (5
  repeated runs of the new and changed test files: 68/68 each).
- `pnpm format:check` pass; `pnpm lint` pass; `pnpm typecheck` 7/7; `pnpm test` 7/7 tasks
  (runner 208 tests, 100% statements/branches/functions/lines; core 238, database 120, web 144,
  cli 75, benchmark-engine 110, agent-adapters 34); `pnpm build` 2/2; `pnpm verify:pack` passed;
  `pnpm test:e2e` 37 passed.
- Real app: built CLI, `serve` with a temporary data dir, github.com reachable, UI driven by a
  Playwright script:
  - `<dataDir>/cache/repos` replaced by a regular file → registering
    `https://github.com/anthropics/skills` shows "DirectiveBench could not use its cache of
    hosted repositories in the data directory (EEXIST). …", nothing stored.
  - Restored → registered, scanned: 20 artifacts.
  - `chmod 500 <dataDir>/cache/repos` → the rescan succeeded and the directory was 0700 again:
    every hosted job re-tightens that directory, so this alone is not a cache error (see lesson).
  - `chmod 500 <dataDir>/cache/repos/<id>.git` → rescan job `failed` with the fixed message
    (EACCES); the list shows "Failed: DirectiveBench could not use its cache …"; the database has
    `sync_status = 'error'` and the same `sync_error`; the runner log has no absolute path in the
    job line.
  - `chmod 700` again → the next scan succeeded.
- Not verified: a real full disk (`ENOSPC`, covered by injected errors only); Windows.

## Problems and deviations

- The suggested reproduction (`chmod` of `cache/repos`) does not fail because `prepare`
  re-chmods it; the check used a read-only per-repository cache and a file in place of
  `cache/repos` instead.
- A test of "size check fails after git exited" could not cover the post-close branch
  deterministically; the guard was dropped instead: a size-check failure seen by `runStep` is
  always thrown (fail closed).

## Lessons recorded

- [2026-10-21-simulate-errors-the-code-cannot-repair.md](../lessons/2026-10-21-simulate-errors-the-code-cannot-repair.md) (new)

## Follow-ups

- Database errors on the hosted path (`registerHostedRepository`, `markRepositoryScanFailed`)
  still reach the runner's generic catch with Drizzle's message (no secrets: the location is
  validated); a fixed message for unexpected job errors could cover all job types.
- A dedicated `cache-failed` error code, if the UI ever distinguishes it.
