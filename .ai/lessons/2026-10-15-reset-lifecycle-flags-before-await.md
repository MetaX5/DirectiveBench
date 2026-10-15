---
title: Reset lifecycle flags before the first await in start()
date: 2026-10-15
tags: [runner, concurrency]
source: .ai/runs/2026-10-15-ci-coverage-and-integration-tests.md
---

# Reset lifecycle flags before the first `await` in `start()`

## Context

`LocalRunner.start()` awaited `recover()` and only then set `stopping = false`. A `stop()` that
arrived while recovery was running was silently undone, and the runner kept polling and executing
jobs after shutdown. Found while writing coverage tests; regression test "stays stopped when
stop() is called while start() is still recovering" in
`packages/runner/test/runner-lifecycle.test.ts`.

## Lesson

In async lifecycle methods, any state written after an `await` can overwrite a concurrent
transition that happened during the wait.

## How to apply

Set lifecycle flags synchronously at the top of `start()`, and re-check them after every
`await` before scheduling work. Test `stop()` racing an unfinished `start()`.
