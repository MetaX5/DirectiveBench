---
title: An await between a check and the statement it guards is a race, even in single-threaded JavaScript
date: 2026-10-19
tags: [database, concurrency, testing]
source: .ai/runs/2026-10-19-pr-44-review-fixes.md
---

# An await between a check and the statement it guards is a race, even in single-threaded JavaScript

## Context

The first fix for the shared `node:sqlite` connection (issue #16) made the Drizzle proxy run
`await waitForForeignTransaction(sqlite)` and then `prepare` the statement. The independent review
of PR #44 reproduced a lost write in 11 of 144 interleavings: when the check found no open
transaction, the `await` still yielded one microtask, a queued `withTransaction` ran
`BEGIN IMMEDIATE` in it, and the outside statement then executed inside that transaction and was
rolled back with it. The existing isolation test passed because it waited a full macrotask
(`setImmediate`) before issuing the outside statement, which never hits the gap.

## Lesson

Check-then-act on shared state needs the check and the act in the same synchronous step. An
`await` on an already-resolved promise still lets every queued microtask run first, so "nothing
is open" can be false by the time the next line runs. Loop instead: `for (let open = check();
open; open = check()) await open;` followed directly by the synchronous action. Microtask races
are deterministic, so they can be tested deterministically — but only by sweeping the offsets,
because a single hand-picked ordering usually misses the one microtask that matters.

## How to apply

- In code that shares a connection or other state across async work, never put an `await`
  between the condition and the operation it guards; re-check in a loop after each wait.
- Test such code with a sweep: issue the competing operations with 0…N microtasks between them,
  in both orders, and assert the invariant for every offset
  (`packages/database/test/client.test.ts`, "never lets an outside statement join a transaction
  that begins right next to it"). Call a Drizzle query's `then` synchronously in such tests:
  `Promise.resolve(query)` defers it by one microtask, and query builders are lazy thenables that
  run again on every `then`.
- Prove the regression test against the old code before trusting it.
