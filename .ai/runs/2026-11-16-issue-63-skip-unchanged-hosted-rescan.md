---
title: Skip fetching and scanning a hosted repository whose remote head equals the last scanned commit (issue 63)
date: 2026-11-16
agent: Claude Code / claude-opus-5-5
trigger: maintainer request; issue 63 (follow-up from PR 62), approach approved 2026-11-16
status: in-progress
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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Tests first (red)

- [ ] 1.1 Write failing tests for the remote head check, the fast path and the configuration hash

### Phase 2: Implementation

- [ ] 2.1 Remote head check in hosted-git.ts
- [ ] 2.2 Database: result fields, baseline read and unchanged write
- [ ] 2.3 Runner fast path, configuration hash and appVersion plumbing

### Phase 3: Specs and verification

- [ ] 3.1 Update SPEC-105, SPEC-103 and the database schema spec
- [ ] 3.2 Quality gate, real-app check, Codex review and om-auto-review-pr

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
