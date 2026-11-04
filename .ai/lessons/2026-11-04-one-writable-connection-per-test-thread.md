---
title: A test that stands for two processes must not open two writable SQLite connections in one thread
date: 2026-11-04
tags: [testing, database, runner, flaky, macos]
source: .ai/runs/2026-11-04-issue-174-serve-runner-flaky-failed-job.md
---

# A test that stands for two processes must not open two writable SQLite connections in one thread

## Context

`packages/runner/test/runner-acquired.test.ts` "a serve runner polling the same data directory
never acquires the CLI job" (issue #174) failed now and then on the macOS unit job: one of the two
benchmark jobs ended `failed`. The test simulated the `benchmark run` and `serve` processes with
two `openDatabase` connections in the vitest thread. With the job's error printed, a macOS probe
showed `Benchmark failed: database is locked`, and an instrumented probe showed why: one runner's
`BEGIN IMMEDIATE` waited 6942 ms while the other connection's `insertAgentRun` transaction stayed
open. The test never reproduced on Linux, even under `taskset` and `yes` load; a Linux detector
that only checked plain statements (not `BEGIN`) saw no overlap and was misleading.

## Lesson

`node:sqlite` waits for a lock synchronously (`busy_timeout`, 5 s). Two writable connections in
one thread deadlock for the timeout as soon as their transactions overlap: the waiting connection
blocks the event loop that has to commit the other one, then fails with "database is locked".
This is the [shared-connection lesson](2026-10-19-shared-connection-transactions.md) in a test:
the product opens one writable connection per process, so the bug was only in the simulation.

## How to apply

- In a test, runners or callers that stand for separate processes share one connection (or run
  in a real separate process or worker); never two writable `openDatabase` handles in one thread
  that may write at the same time.
- A test that waits for a job's status prints the job's `error` and its run's `error` when it is
  not the expected one, so a flaky failure names its cause.
- When a flake reproduces only on a CI platform, push a throwaway branch with a temporary
  workflow (`on: push` for that branch only, a matrix of shards running the suite several
  times) to collect evidence, then delete the branch.
