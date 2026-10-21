---
title: Simulate a file-system error where the code cannot repair it, and catch at one boundary
date: 2026-10-21
tags: [testing, runner, filesystem, error-handling]
source: .ai/runs/2026-10-21-issue-57-cache-error-status.md
---

# Simulate a file-system error where the code cannot repair it, and catch at one boundary

## Context

Issue #57: an error on DirectiveBench's own hosted cache (`<dataDir>/cache/…`) escaped the hosted
scan, so the job failed with Node's raw message (`EACCES: permission denied, mkdir '/abs/…'`) and
`sync_status` stayed unchanged. The obvious reproduction — `chmod 500 <dataDir>/cache/repos`
before a scan — shows nothing: `prepare()` runs `ensurePrivateDirectory` (`mkdir` + `chmod 0700`)
on `cache`, `cache/git-home` and `cache/repos` at the start of every hosted job, so a directory
the user owns is made writable again and the scan succeeds. The fs calls were spread over
`hosted-git.ts` (`mkdir`, `chmod`, `lstat`, `readdir`, `rm`) and `hosted-repository.ts` (`rm`),
and a fix at one call site would have left the others open. Two more leaks hid nearby: `lstat`
errors other than `ENOENT` meant "absent: clone", and a file `lstat` could not read counted as
0 bytes towards the cache limit; and Node's spawn error (`spawn /usr/bin/git ENOENT`) names git's
absolute path, also when the real cause is a missing working directory.

## Lesson

- A reproduction must use a state the code under test does not repair: a read-only *parent*, a
  regular file where a directory belongs (`EEXIST`), or a read-only directory the code never
  re-chmods (the per-repository cache), plus injected failures (`vi.mock('node:fs/promises')`
  with `vi.fn(actual.x)` wrappers) for what real permissions cannot produce.
- Catch unexpected errors at the one boundary every step passes through (`onCacheError` around
  the hosted git and cache steps) and turn them into a fixed message with only the errno code;
  check cancellation first (`GitCancelledError`, or any error once the signal fired), so a
  cancelled job is never reported as a failure.
- "Treat an error as absence" must be `ENOENT` only; every other code fails closed.

## How to apply

- Before writing a permission-based test, read what the code does to that path first (`mkdir`,
  `chmod`, `rm`) and prove the test fails without the fix (`git stash push <src>`).
- For new hosted steps, let fs errors throw and rely on `onCacheError` in
  `packages/runner/src/hosted-repository.ts`; never return `error.message` of an fs or spawn
  error to a user-facing message — use `errnoCode` (`packages/runner/src/git-process.ts`).
