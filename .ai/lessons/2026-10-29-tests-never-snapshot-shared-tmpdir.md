---
title: Tests never snapshot shared global state such as os.tmpdir() under parallel workers
date: 2026-10-29
tags: [testing, vitest, flaky]
source: https://github.com/MetaX5/DirectiveBench/issues/143
---

# Tests never snapshot shared global state such as os.tmpdir() under parallel workers

## Context

`apps/cli/test/benchmark-run.test.ts` listed every `directivebench-suite-*` entry in the shared
`os.tmpdir()` before and after a declined `benchmark run` and expected equal lists. Other Vitest
workers run `benchmark run` at the same time and create and remove directories with the same
prefix, so the required "Unit tests (100% coverage)" check failed on about 1 in 4 CI runs with an
extra foreign entry, on `main` and on unrelated PRs.

## Lesson

A before/after snapshot of a directory, environment or other process-wide resource that parallel
workers also use is a race, not an assertion. Isolate the resource the code under test touches
and assert on that alone.

## How to apply

- Point `os.tmpdir()` at a private `mkdtemp` directory for the test with
  `vi.stubEnv('TMPDIR', dir)` (POSIX reads `TMPDIR` on every call; Windows uses `TEMP`/`TMP`),
  restore with `vi.unstubAllEnvs()` in `afterEach`, and assert on that directory's contents.
- Prove the isolated assertion still catches the bug red-first (e.g. skip the cleanup it guards).
