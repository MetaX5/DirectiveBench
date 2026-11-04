---
title: A branch reached only by output that follows a kill is covered by the OS pipe, not by the test
date: 2026-11-04
tags: [testing, coverage, flaky, macos, process]
source: .ai/runs/2026-11-04-issue-184-timing-flakes.md
---

# A branch reached only by output that follows a kill is covered by the OS pipe, not by the test

## Context

On PR #183 the macOS unit job failed on coverage: `process.ts | 98.34 | 94.44 | 100 | 100 |
97,229` in `packages/agent-adapters` (job 126793890842); main passed on the same code (issue
184). Line 97 is `LineCollector.push` returning early once the stdout limit was exceeded, and line
229 is `terminate()` returning when SIGTERM was already sent. Only the `flood` test reached them,
and only when stdout delivered another chunk after the one that crossed the limit, before SIGTERM
ended `yes`. On Linux the full pipe always held that chunk: two of them in each of 23 runs of the
test (3 idle, 20 under `taskset -c 0,1` with six `yes` processes), and the package's coverage was
identical in each of 5 loaded runs. On macOS the writer sometimes did not run again before the
signal arrived, and no chunk came (inferred from the job's uncovered lines; macOS pipes start
smaller than Linux's 64 KiB).

## Lesson

A guard against "more events after we decided to stop" (late output, a second timeout, a signal
after exit) is reached by a real child process only on some timings, and which timings depends on
the OS, so Linux load cannot reproduce it. Coverage of such a guard must come from a test that
emits the events itself.

## How to apply

- Cover event-order guards with a stub child (`vi.mock('node:child_process')` returning an
  `EventEmitter` with `stdout`, `stderr` and `stdin`, process-group helpers mocked) and emit the
  events in the order under test, as `packages/agent-adapters/test/claude-code/process-events.test.ts`
  does. Assert the guard's effect (one SIGTERM, no signal after exit), not only the coverage, and
  prove it fails with each half of the guard removed.
- Keep the real-process test for the end-to-end behaviour; it just must not be the only cover.
- To find candidates, dump the per-statement hit counts (`--coverage.reporter=json`) of the
  real-process tests: a statement hit once or twice, by events that happen after a kill, is one.
- A coverage line that differs between platforms on the same code is a timing finding: compare
  the uncovered columns of the failing job with the code before rerunning.
