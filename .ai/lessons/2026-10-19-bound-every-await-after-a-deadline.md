---
title: A shutdown deadline must bound every await after it, cleanup writes included
date: 2026-10-19
tags: [runner, shutdown, database]
source: .ai/runs/2026-10-19-pr-44-third-codex-review.md
---

# A shutdown deadline must bound every await after it, cleanup writes included

## Context

`LocalRunner.stop()` raced the running jobs against `shutdownTimeoutMs`, then awaited
`interruptJobs` to mark the jobs that did not stop — without any budget. On the shared
`node:sqlite` connection a statement from outside a transaction waits until that transaction ends,
so a job that ignored the abort while holding a transaction kept `stop()` from returning, and the
CLI never got to stop the web child (third Codex review of PR #44).

## Lesson

A deadline that guards only the first wait is not a deadline. Any await after it — cleanup, a
status write, a log flush — can block on the very thing that made the deadline expire. Bound it
with a named grace period, and make sure skipping it is safe (here: `recoverStaleJobs` at a later
runner start marks jobs left `running` as `interrupted`).

## How to apply

- Race the cleanup against a named timer (`SHUTDOWN_INTERRUPT_GRACE_MS`), clear the timer, and
  attach a `.catch` to the raced promise so a late rejection after `stop()` returned is logged,
  not unhandled.
- Log the skipped case with its own event (`shutdown-interrupt-skipped`) and the affected ids.
- Regression test: hold a transaction past the deadline and race `stop()` against
  deadline + grace + slack; on the old code the race reports "still waiting".
