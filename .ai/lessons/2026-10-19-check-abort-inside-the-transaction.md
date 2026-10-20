---
title: Check an abort signal inside the transaction, not before queueing it
date: 2026-10-19
tags: [database, concurrency, runner, cancellation]
source: .ai/runs/2026-10-19-pr-44-second-codex-review.md
---

# Check an abort signal inside the transaction, not before queueing it

## Context

The repository scan (issue #16, PR #44) checked `signal.aborted` right before calling
`applyRepositoryScan`, and the transaction re-checked only the job row (`status`,
`cancel_requested_at`). `withTransaction` serialises transactions on the shared `node:sqlite`
connection, so the apply could wait behind another job's transaction. A runner shutdown that
aborted the signal during that wait was invisible: shutdown updates neither column, so the scan
committed and returned `ok: true` for a job that was being interrupted. The second Codex review
found it; the earlier tests aborted before discovery finished, never during the wait.

## Lesson

Between "check" and "the transaction actually begins" there can be an unbounded wait on a shared
connection. Any condition that must hold for the write — cancellation, shutdown, ownership — has to
be checked inside the transaction callback, before the first write. And an in-memory signal (an
`AbortSignal`) is not in the database, so re-checking the row cannot replace checking the signal:
pass the signal into the repository function.

## How to apply

- Give a repository function that writes on behalf of a cancellable job the job's signal (make it
  required, so no caller forgets), and check it as the first thing in the `withTransaction` callback;
  throw a typed error so the caller maps it to `cancelled`/`interrupted`.
- Keep the cheap pre-check before queueing too (it saves the wait), but never rely on it alone.
- Regression-test the wait: hold the connection with `withTransaction(handle, () => gate)`, queue
  the write, abort, then release the gate (`packages/database/test/artifacts.test.ts`), and through
  the runner by calling `stop()` once the write is queued (`packages/runner/test/repository-scan.test.ts`).
