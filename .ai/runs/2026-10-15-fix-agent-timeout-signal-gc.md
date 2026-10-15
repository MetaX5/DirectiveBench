---
title: Fix the agent timeout signal being lost to garbage collection
date: 2026-10-15
agent: Claude Code / claude-opus-5-5
trigger: user report — CI failed on PR #6 (docs-only change)
status: completed
branch: fix/agent-timeout-signal-gc
specs: [SPEC-110, SPEC-107]
---

# Run: Fix the agent timeout signal being lost to garbage collection

## Objective

Find out why "gives up on an agent that ignores the abort signal after the grace period"
(`packages/benchmark-engine/test/orchestrator.test.ts`) failed on CI run 38722451673. That run
tested a docs-only commit, and the previous run on the same code had passed. Fix the root cause
and add a regression test.

## Plan

Read the failing assertion → check whether the test's assumption (`requests[0]` is the baseline
run) holds → read Node's `internal/abort_controller` → reproduce deterministically → fix → prove
the fix.

## Decisions

- Fix in the orchestrator, not in the test. An adapter that polls `signal.aborted` would miss
  the timeout in production too, so this is a real bug that the test exposed.
- `agentAbortSignal` returns a plain `AbortController` signal and the caller disposes of it in
  `finally`. A plain signal keeps its own aborted state, so GC cannot lose it.
- New guard: if the run is already cancelled, the agent is not started. Without it, the agent
  could get a signal that never aborts, because `abort` listeners don't fire for a signal that is
  already aborted.
- The signal is disposed of in `try/finally`, not `.finally()` on the promise, so the timer and
  the listener are also removed when `adapter.run` throws synchronously.

## Work performed

1. Ruled out ordering: variants run one after another, baseline first, so `requests[0]` is the
   baseline request.
2. Read Node 24.21's `internal/abort_controller`. `AbortSignal.any()` follows its sources lazily
   through `WeakRef`. The fired timeout signal is removed from `gcPersistentSignals`, so a GC
   collects it and `refreshCompositeSignal` drops it. After that, `.aborted` stays `false`.
3. Regression: `collectGarbage()` test helper (`v8.setFlagsFromString('--expose-gc')`), called
   before the assertion. The test failed on 3 of 3 runs with the old code, with the same error as
   CI.
4. Fix: `agentAbortSignal()` plus the cancellation guard in `orchestrator.ts`. New test: "does not
   start the agent when cancelled while the artifact was installed".

## Verification

- Old code: both tests fail ("expected false to be true" and the cancellation test).
- New code: `vitest run test/orchestrator.test.ts` passed 16/16 on each of 3 runs; the
  `benchmark-engine` package passes 110/110 with 100% statements, branches, functions and lines.
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — pass (7/7 turbo tasks).
- Not verified: the failure was never reproduced without forcing GC. That the CI flake had this
  cause is inferred from the identical symptom (aborted `false` after more than 5 s) and the Node
  source.

## Problems and deviations

- Found while checking PR #6. That PR is unrelated and only re-runs its failed job.

## Lessons recorded

- [AbortSignal.any() loses a fired AbortSignal.timeout() once it is garbage-collected](../lessons/2026-10-15-abortsignal-any-loses-gc-collected-timeout.md)

## Follow-ups

- The unnamed `timeoutMs + 5000` grace period is still open (SPEC-014 §11); not changed here, to
  keep this fix focused.
