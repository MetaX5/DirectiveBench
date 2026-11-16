---
title: Prove an unhandled-rejection fix on the promise nobody awaits
date: 2026-11-16
tags: [testing, runner, promises]
source: .ai/runs/2026-11-16-issue-46-runner-stop-claims.md
---

# Prove an unhandled-rejection fix on the promise nobody awaits

## Context

Issue 46 said a job that outlives `LocalRunner.stop()` rejects unobserved when its `finishJob`
fails. The first regression test (a job that ignored the abort, its connection closed after
`stop()`) recorded no `unhandledRejection` on the old code. `stop()` had already attached
`Promise.allSettled` to every job it saw, which counts as a handler. The rejection was real only
for a job that no one awaited: one claimed after `stop()` took its snapshot of active jobs (a poll
claiming past the deadline). That test showed 1 `unhandledRejection` on the old code.

## Lesson

Node reports a rejection as unhandled only when no consumer at all attached to that promise:
`allSettled`, `race`, `then` or `catch` in any caller. So a test that rejects a promise someone
else observes passes on the buggy code.

## How to apply

- Before you write the test, list every consumer of the promise (`void` call sites, `race`,
  `allSettled`). Drive the path where none of them is attached.
- Assert with a `process.on('unhandledRejection', spy)` listener, removed in `finally`. Wait
  a macrotask before checking it, then confirm the test fails on the old code.
