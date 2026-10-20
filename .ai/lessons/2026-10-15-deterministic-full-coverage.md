---
title: 100% branch coverage must not depend on the machine or on random IDs
date: 2026-10-15
tags: [testing, coverage]
source: .ai/runs/2026-10-15-ci-coverage-and-integration-tests.md
---

# 100% branch coverage must not depend on the machine or on random IDs

## Context

While raising every package to 100% coverage, some branches were hit on one machine and missed
on another, and some tests were flaky:

- Sort comparators over `readdir` results (`a < b ? -1 : 1`) take different branches depending
  on the order the file system returns entries (sorted on ext4/APFS listings, reversed or hashed
  elsewhere), so branch coverage changed between machines.
- Jobs are ordered by `created_at, id`, and IDs are random; jobs created in the same millisecond
  came out in a random order, so FIFO assertions were flaky.

## Lesson

A 100% threshold turns any environment-dependent branch into an intermittent CI failure, and any
ordering on random IDs into a flaky test.

## How to apply

- Write comparators without environment-dependent branches (e.g.
  `Number(a > b) - Number(a < b)`), or test both orders with a simulated listing.
- Control time with `vi.useFakeTimers({ toFake: ['Date'] })` and `vi.setSystemTime` when tests
  depend on timestamp order; never rely on the order of random IDs.
- Run a new test file several times (`--repeat` or a loop) before relying on it.
- Do not rely on timing for coverage either (added 2026-10-20, #18): a real `git clone` killed by
  the cache-size watch covered the "watch fired" branch only when a poll landed during the clone;
  under the parallel `pnpm test` load the clone sometimes finished first and runner coverage fell
  below 100%. Cover such branches with a deterministic fake (a fake git that writes past the limit
  and then keeps running, `packages/runner/test/hosted-git.test.ts`).
