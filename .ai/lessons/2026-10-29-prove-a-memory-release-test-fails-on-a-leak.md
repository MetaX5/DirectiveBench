---
title: Prove a memory-release test fails on a real leak before trusting it
date: 2026-10-29
tags: [testing, memory, gc]
source: .ai/runs/2026-10-29-agent-run-output-files-capture.md
---

# Prove a memory-release test fails on a real leak before trusting it

## Context

SPEC-123 FR-123-10 requires that the engine drop each agent run's output-file capture once
`onAgentRun` resolved. The test keeps a `WeakRef` to every capture, runs `collectGarbage()` in the
next callback and expects every earlier ref to be cleared. Moving the capture out of the
`runBenchmark` loop into a helper frame did not change the result: the inline version passed too,
so "it passes" said nothing about whether the test could fail at all.

## Lesson

A `WeakRef` + `gc()` test proves release only if it has been seen to fail on a retained object.
Without that check it may pass because the collector or the test setup never held the value in
the first place, or fail to notice because `deref()` is checked too early.

## How to apply

When adding a memory-release test, inject a deliberate leak once (for example attach the object
to a record the engine keeps, or push it to a module-level array), confirm the test fails, then
remove the leak. Record that red proof in the run log or PR. Use the shared
`collectGarbage()` helper (`test-support/linear-time.ts`) rather than a local `gc` setup.
