---
title: A test that forces a backstop must assert that its seam fired
date: 2026-11-05
tags: [testing, database, sqlite]
source: .ai/runs/2026-11-05-category-names-and-repository.md
---

# A test that forces a backstop must assert that its seam fired

## Context

SPEC-124's category functions check for a name or slug clash inside `withTransaction` and rely
on the unique indexes as a backstop. That backstop path maps `SQLITE_CONSTRAINT_UNIQUE` to
`name-taken` / `slug-taken`. The in-transaction check catches every clash first, so the tests
reach the backstop through `packages/database/test/support/intercept.ts`. It is a Drizzle proxy on
the same connection that hides the result of the clash check, which is matched by its SQL text.
The review of PR #190 broke those patterns on purpose, and all 17 tests still passed: when
nothing is hidden, the ordinary check returns the same outcome as the backstop. Only the 100%
coverage threshold would have noticed.

## Lesson

When a test forces a rarely reached path through a seam (an interceptor, a fake, a trigger, a
mocked response), and the normal path gives the same observable result, the test also has to
assert that the seam fired. Otherwise it passes without testing the path.

## How to apply

- Count the seam's activations and assert the count (`withMissedCheck` in
  `category-lifecycle.test.ts` expects exactly one hidden statement).
- Prove it once: break the seam (for example, a pattern that matches nothing) and check that the
  test fails.
- SQLite's unique violation reaches you through Drizzle as `DrizzleQueryError` with
  `cause.errcode === 2067` (`SQLITE_CONSTRAINT_UNIQUE`). To produce a violation that no row
  can explain, use a `BEFORE` trigger that inserts the clashing row. That row rolls back with the
  failed statement.
