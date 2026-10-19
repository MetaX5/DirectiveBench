---
title: On the shared node:sqlite connection, statements from outside a running transaction join it
date: 2026-10-19
tags: [database, runner, concurrency]
source: .ai/runs/2026-10-19-issue-16-scan-local-repository.md
---

# On the shared node:sqlite connection, statements from outside a running transaction join it

## Context

The runner gave registrations their own lane (issue #16), so two jobs now write through the same
`DatabaseHandle` at the same time. `withTransaction` only serialised other `withTransaction`
calls: the Drizzle `sqlite-proxy` driver is asynchronous, so while one job's transaction awaited
between statements, another job's plain `finishJob` or the heartbeat ran on the same connection
*inside* that open transaction — and would have been rolled back with it. A sceptical plan review
found it before any test did. In the same change, `LocalRunner.runUntilIdle` lost a job that
finished while `poll()` was still filling the second lane: it only collected `Promise.race`
winners of jobs still in `active`.

## Lesson

SQLite transactions belong to the connection, not to the async call chain. Any code that shares a
connection between concurrent async work needs to keep foreign statements out of an open
transaction. `withTransaction` now records the open transaction in an `AsyncLocalStorage` scope,
and the proxy makes any statement from outside that scope wait until the transaction ends. A
second connection in the same process is not a fix: `node:sqlite` waits for locks synchronously
(`busy_timeout`), so it would block the event loop that has to finish the first transaction.
Collect job results as they finish, not by racing the jobs that are still active.

## How to apply

- Keep multi-statement writes in `withTransaction`, and never await unrelated I/O inside its
  callback, or every other statement on the connection waits for it.
- A test for new shared-connection behaviour starts a transaction, issues a plain statement from
  outside it while the transaction is still open, fails the transaction, and checks that the outside
  statement survived (`packages/database/test/client.test.ts`).
- Guard terminal job transitions (`finishJob` updates only `pending`/`running` rows), so a late
  finish after a shutdown timeout cannot overwrite `interrupted`.
