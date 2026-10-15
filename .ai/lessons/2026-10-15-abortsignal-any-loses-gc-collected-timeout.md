---
title: AbortSignal.any() loses a fired AbortSignal.timeout() once it is garbage-collected
date: 2026-10-15
tags: [node, testing, flaky, cancellation]
source: .ai/runs/2026-10-15-fix-agent-timeout-signal-gc.md
---

# AbortSignal.any() loses a fired AbortSignal.timeout() once it is garbage-collected

## Context

The orchestrator passed agents `AbortSignal.any([input.signal, AbortSignal.timeout(ms)])`. The
test "gives up on an agent that ignores the abort signal after the grace period" failed on CI
only sometimes (PR #6, a docs-only change). It checked `signal.aborted` and got `false`, more
than 5 s after a 50 ms timeout. It never failed locally.

## Lesson

On Node 24.21, a composite signal from `AbortSignal.any()` holds its sources only through
`WeakRef` until someone adds an `abort` listener to it. Until then, `.aborted` is computed lazily
from those sources. When the timeout fires, Node drops the timeout signal from its keep-alive
set. If nothing else references it, the next GC collects it. After that, the composite's lazy
check finds no source and reports `false` forever. Code that listens for `abort` is not
affected. Code that polls `signal.aborted` is, and it fails only when a GC happens to run in that
window, so the bug looks random.

## How to apply

- When a signal is handed to code you do not control, don't build it from
  `AbortSignal.any(...AbortSignal.timeout())`. Use a plain `AbortController`, a `setTimeout`, and
  an `abort` listener on the parent signal, all removed in `finally` (`agentAbortSignal` in
  `packages/benchmark-engine/src/orchestrator.ts`).
- When a test relies on an object staying alive, call `collectGarbage()` from
  `packages/benchmark-engine/test/helpers.ts` before the assertion. It turns this kind of failure
  into one that reproduces every time.
- A CI failure on a change that touches no code is evidence of a flaky test, not noise.
  Reproduce it before re-running.
