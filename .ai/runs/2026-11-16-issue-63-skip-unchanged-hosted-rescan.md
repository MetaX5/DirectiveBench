---
title: Skip fetching and scanning a hosted repository whose remote head equals the last scanned commit (issue 63)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issue 63 (follow-up from PR 62), approach approved 2026-11-16
status: completed
branch: feat/issue-63-skip-unchanged-hosted-rescan
specs: [SPEC-105, SPEC-103, SPEC-003]
---

# Run: skip unchanged hosted rescans (issue 63)

## Objective

Implement SPEC-105 FR-105-10 (fast path) and §9.1 step 0 for `github` repositories:

- Given an unchanged remote, a rescan runs no fetch, is recorded as unchanged and creates 0
  versions.
- Given a changed remote, the scan runs as today.
- A changed scan configuration (include roots, exclude globs, formats, and per FR-105-10 the
  discovery/parser version) since the last successful scan still forces a scan.
- The remote head check is `ls-remote`, hardened like every other hosted git call in
  `packages/runner/src/hosted-git.ts`, and runs in the runner only.
- Tests use the local bare-remote transport, no network; 100% coverage.

Non-goals: `apps/web` (no UI change expected: the existing result fields render the outcome),
local scans (no fast path for `local-directory`; `local-git` reads the working tree), `sync_runs`.

## Plan

1. `hosted-git.ts`: `resolveRemoteHead(context, location, branch)` = `ls-remote -- <url>
   refs/heads/<branch>` through the same `runStep` (allowlisted env, hardened `-c` prefix, one
   protocol, `HOSTED_GIT_TIMEOUTS.lsRemote`, bounded output); exact ref match; null when the
   branch is absent.
2. `database`: the scan result gains `scanConfigHash` (nullable, default null) and `unchanged`
   (default false); `getHostedScanBaseline(db, repositoryId)` reads the latest completed scan job
   of the repository; `recordUnchangedRepositoryScan(handle, …)` re-checks the job and the
   repository in one transaction and records the successful sync without touching versions.
3. `hosted-repository.ts`: the configuration hash (app version, formats, include roots, exclude
   globs, skipped directories, discovery limits); the fast path before step 1 when the baseline
   matches; `LocalRunnerOptions.appVersion` passed by `serve`; absent → no fast path (fail
   closed).
4. Specs: SPEC-105 FR-105-10 / §9.1 step 0 / §20, SPEC-103 §20, database schema §3.11.

## Progress

PR: #242

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Tests first (red)

- [x] 1.1 Write failing tests for the remote head check, the fast path and the configuration hash — 8d76ba7

### Phase 2: Implementation

- [x] 2.1 Remote head check in hosted-git.ts — 20f8ed7
- [x] 2.2 Database: result fields, baseline read and unchanged write — cc6d81d
- [x] 2.3 Runner fast path, configuration hash and appVersion plumbing — 5b9bad8

### Phase 3: Specs and verification

- [x] 3.1 Update SPEC-105, SPEC-103 and the database schema spec — 50f5b29
- [x] 3.2 Quality gate, real-app check, Codex review and om-auto-review-pr

## Decisions

- **Configuration change detection.** The result of a hosted scan stores `scanConfigHash`, the
  SHA-256 of the DirectiveBench version, formats, include roots, exclude globs (both empty: they
  cannot be configured yet), skipped directories and discovery limits. A rescan may skip only
  when the repository's latest completed scan stored the same hash; a result stored before this
  change has none, so the first rescan after the upgrade reads the repository again.
- **The DirectiveBench version is part of the hash** (FR-105-10 names the discovery/parser
  version): an upgrade may change what discovery finds in the same commit. The runner gets it
  from `serve` (`LocalRunnerOptions.appVersion`, the CLI package version); without it no rescan
  skips (fail closed), so existing callers and tests keep today's behaviour.
- **Baseline = latest completed scan job + repository sync state.** The baseline counts only
  when `sync_status = 'ok'` and `last_commit_sha` equals its commit, so a recorded failure, or an
  apply that committed without its job finishing, forces a full scan.
- **The unchanged result repeats the baseline's discovery counts** (`scannedFiles`,
  `discovered`, warnings, errors, `emptyScanKeptOccurrences`) with every change count 0 and
  `unchanged: true`. The Repositories page then shows exactly what a rescan that changed nothing
  shows today ("… found (0 new, 0 new versions) …"), so no UI change; reporting 0 discovered
  would have read as "the repository is empty".
- **`last_seen_at`** of the active occurrences found at that commit is refreshed, as a rescan
  that read the commit would; occurrences kept from older commits (unobserved paths, the
  empty-scan guard) are not, since nothing saw them.
- **A failed `ls-remote` fails the scan** with the usual classification instead of falling back
  to a fetch, which would fail the same way. A branch the remote no longer has falls through to
  the full scan, which reports `branch-not-found`.
- **A repository whose sync state changed between the job's start and the write** (the
  conditional update matches no row) is scanned in full rather than failed.

## Work performed

- `dab9710` run log and plan.
- `8d76ba7` red tests: `hosted-git.test.ts` (fake git: argv, environment, exact ref match, no
  head, classification), `hosted-repository.test.ts` (real git over `file://`, a logging git on
  `PATH`), `packages/database/test/unchanged-scan.test.ts`.
- `20f8ed7` `resolveRemoteHead` (§9.1 step 0) in `hosted-git.ts`.
- `cc6d81d` `scanConfigHash`/`unchanged` (optional) in the scan result schema,
  `getLastCompletedRepositoryScan`, `recordUnchangedRepositoryScan` (job re-check shared with
  `applyRepositoryScan` as `assertScanStillRunning`).
- `5b9bad8` fast path in `scanHostedRepository`, `hostedScanConfigHash`, `scanStoreFailure`
  (extracted from `storeScanResults`), `LocalRunnerOptions.appVersion`, `serve` passes the CLI
  version (with a red-first test in `apps/cli/test/serve.test.ts`).
- `50f5b29` SPEC-105 §20 (decision, behaviour, not verified), acceptance criterion note,
  SPEC-103 §20, database schema §3.11.

## Verification

| Command | Result |
| --- | --- |
| red: `vitest run test/hosted-git.test.ts test/hosted-repository.test.ts` (runner) before the implementation | 10 failed (missing functions; old code ran `version, fetch, clone` where `version, ls-remote` was expected) |
| red: `vitest run test/unchanged-scan.test.ts` (database) | 6 failed (functions missing) |
| red: `serve.test.ts -t "CLI version"` with `serve.ts` reverted | 1 failed: `expected undefined to be '0.2.0-rc.0'` |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass (7 tasks) |
| `pnpm test` | pass, 100% statements/branches/functions/lines in every package (runner 304 tests, database 327, cli 202, web 588) |
| `taskset -c 0,1 vitest run test/hosted-repository.test.ts test/hosted-git.test.ts` | 97 passed; issue 63 tests 96 to 199 ms each (budget `REAL_GIT_TEST_TIMEOUT_MS` 30 s) |
| `pnpm build` | pass |
| `TMPDIR=/var/tmp/... pnpm verify:pack` | pass (directory removed) |
| real run: `LocalRunner` from source as `serve` builds it (`appVersion` = CLI version), file transport to a bare repository under `/var/tmp`, logging git on `PATH` | first scan: `version,clone,rev-parse,ls-tree,cat-file,fetch,cat-file,cat-file`, 2 new; rescan: `version,ls-remote`, `unchanged=true`, 0 new, 0 new versions, same commit and hash; after a new commit: `version,ls-remote,fetch,…`, 1 new version |

Not verified: a real github.com remote (no network; the built CLI only speaks HTTPS to
github.com and has no file transport, so the real run used the runner from source with the
test transport); Windows and macOS (the logging-git tests are POSIX-only).

## Review

- Codex adversarial review (`--scope branch --base main`), round 1: no material findings;
  verdict `needs-attention` only because `pnpm verify:pack` could not run in its read-only
  sandbox (it passed here with `TMPDIR` on disk). Round 2: **approve**, no material findings.
- `om-auto-review-pr 242 --autofix` (engine `om-code-review`): full gate passed at the head,
  verdict approve (posted as a COMMENT review, own PR); one nit (the `json_extract` filter of
  `getLastCompletedRepositoryScan` has no index; negligible today), no fix needed.

## Problems and deviations

- The first attempt at the real run used `npx tsx` from `packages/runner`, which has no `tsx`;
  it ran with `apps/cli`'s `tsx` instead.
- No deviation from the approved approach. The DirectiveBench version in the configuration hash
  goes beyond the three settings named in the issue, because FR-105-10 also names the
  discovery/parser version.

## Lessons recorded

- [2026-11-16-prove-a-skipped-git-step-with-a-logging-git.md](../lessons/2026-11-16-prove-a-skipped-git-step-with-a-logging-git.md)

## Follow-ups

- Development builds share one version (`0.2.0-rc.0`), so changed discovery rules on a branch do
  not force a rescan of an unchanged remote until the version changes.
- If job history grows large, index the repository id of scan jobs (review nit).

## Merge with main after #241

- `git merge origin/main` (no rebase) brought in #241 (issue 45, `skippedUserLevelFolderCount`).
- Conflicted: only `.ai/specs/2026-10-14-database-schema.md` §3.11 (`jobs.result`). Resolved to
  #241's full scan-result shape with `scanConfigHash?` and `unchanged?` added, documenting every
  field once (hosted scans store `skippedUserLevelFolderCount: 0`; `scanConfigHash` and
  `unchanged` stay absent in older results).
- Auto-merged but semantically incomplete: the unchanged-skip result in
  `packages/runner/src/hosted-repository.ts` did not write `skippedUserLevelFolderCount`. It now
  writes 0, like the full GitHub scan. The `toEqual` in the "rescans an unchanged remote with
  ls-remote alone" test now expects it, and the stored-result check asserts it too. Red first:
  without the runner line that test fails on the missing `skippedUserLevelFolderCount: 0`.
- Gate on the merge: `pnpm format:check`, `pnpm lint`, `pnpm typecheck` pass; `pnpm test` pass
  with 100% coverage in every package; `pnpm build` pass; `pnpm verify:pack` (`TMPDIR` under
  `/var/tmp`, removed) pass; `pnpm test:e2e` (`TMPDIR` under `/var/tmp`) 180 passed, which
  includes #241's issue-45 repository tests.
