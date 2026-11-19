---
title: On Node 22.16 tests lose native type stripping and the per-thread CPU clock
date: 2026-11-19
tags: [testing, node, ci, timing]
source: .ai/runs/2026-11-19-issue-266-web-tests-node-22-16.md
---

# On Node 22.16 tests lose native type stripping and the per-thread CPU clock

## Context

Issue 266: the `apps/web` unit tests failed on Node 22.16.0, the `engines.node` minimum, in two
ways. The real-thread highlight tests start the unbuilt worker entry
`lib/syntax-highlight-worker.ts` in a `node:worker_threads` worker; Vitest transforms test
imports, but not a file a worker thread loads itself, and Node strips TypeScript types by
default only from 22.18, so the worker failed and answered `{ kind: 'plain', reason: 'failed' }`.
Separately, `parseMarkdown`'s linear-time test measured 3.5 to 4.4 for the `*a*a…` shape against
the 3.5 bound: `process.threadCpuUsage` exists only from Node 23.9, and the process-wide
`process.cpuUsage()` fallback also bills V8's helper threads. On Node 22.22 the same shape
measured 1.7 to 1.9 with the thread clock and 2.5 to 6.3 with the process clock; wall-clock time
measured 0.2 to 2.9 on a busy machine, and `--single-threaded-gc` did not help (2.4 to 5.2).

## Lesson

- A worker thread or child process started from a test runs outside Vitest's transform: on Node
  before 22.18 it needs `--experimental-strip-types` to load a `.ts` file. Worker threads inherit
  `process.execArgv`, so Vitest's `test.execArgv` reaches them.
- Timing bounds calibrated with the per-thread CPU clock do not hold with the process clock on
  Node 22: linear code can exceed `MAX_LINEAR_RATIO`. `expectLinearTime` uses
  `MAX_LINEAR_RATIO_WITHOUT_THREAD_CLOCK` (12) for synchronous code there, which still fails
  quadratic code; N^1.5 detection relies on Node 24.

## How to apply

- Run a package's tests on Node 22.16 before relying on them in the `oldest-node` job
  (download the release into `.ai/tmp/`, put its `bin` first on `PATH`, run
  `corepack pnpm --filter <pkg> test --coverage.enabled=false` a few times).
- Gate a Node flag on the feature, not the version: `process.features.typescript ? [] :
  ['--experimental-strip-types']`.
- Do not tighten a linear-time bound for one shape on old Node; probe the ratio with both
  clocks first (a temporary test that runs `linearTimeRatio` five times and writes the values
  to a file, since Vitest hides console output of passing tests).
