---
title: Prove an adversarial regex input backtracks before testing a bound with it
date: 2026-10-22
tags: [testing, security, regex, worker-threads]
source: .ai/runs/2026-10-22-issue-94-document-assertions.md
---

# Prove an adversarial regex input backtracks before testing a bound with it

## Context

SPEC-118 FR-118-46 bounds user regular expressions in a `node:worker_threads` worker with
`ASSERTION_REGEX_TIMEOUT_MS`. Its test list names `(.*a){20}` "on a long line". The first test
used `'a'.repeat(5000)`, which **matches** in 8 ms — the timeout test failed because the pattern
finished, not because the bound was broken. The catastrophic case needs a line with fewer than 20
`a` spread out (`('x'.repeat(100) + 'a').repeat(19)`), so every split is tried before the match
fails. `(a|a)*b` on 28 `a` takes ~25 s on the main thread; `(a+)+$` on 32 `a` + `!` far longer.

## Lesson

A pattern is only catastrophic for inputs on which the match **fails** after exploring many
splits. A test that bounds evaluation time is armed only if its input demonstrably takes longer
than the bound without it.

Running the worker from an inline source (`new Worker(source, { eval: true })`) works the same
from TypeScript sources under Vitest, the tsup bundle and the packed CLI, with no separate entry
file to bundle or copy; `verify:pack` and the demo exercise it through `file-contains`. The inline
source is a string, so coverage cannot instrument it — test its behaviour end to end instead.

## How to apply

- Before using an input in a regex timeout test, time `new RegExp(p).test(input)` on the main
  thread (with a shell `timeout`) and keep only inputs that run for seconds or longer.
- Run several adversarial evaluations concurrently in one test so the real 2 s deadline does not
  multiply the suite time, and bound wall time with a wide margin (lesson 2026-10-21 on timing
  tests under load).
