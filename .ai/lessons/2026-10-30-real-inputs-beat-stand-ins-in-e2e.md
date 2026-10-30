---
title: Drive browser checks through a real CLI run and real inputs before reaching for stand-ins
date: 2026-10-30
tags: [testing, e2e, syntax-highlighting]
source: .ai/runs/2026-10-30-spec-123-close-acceptance.md
---

# Drive browser checks through a real CLI run and real inputs before reaching for stand-ins

## Context

SPEC-123's acceptance criteria AC-3, AC-11 and AC-16 stayed open after all five phases merged:
the browser tests used seeded rows for the redaction count and a stand-in worker for the
highlighting deadline, because "a real capture" and "a stalled grammar on a page" looked out of
reach for Playwright (`serve` is mock-only, Shiki looked fast).

Both were reachable:

- `directivebench benchmark run` of the built CLI can run against the e2e data directory while
  the server runs, with a fake `claude` on its PATH that writes files and replays a recorded
  stream. The adapter stops a run as `artifact-not-loaded` unless the session start lists the
  installed skill, so the recorded stream's skill name (`pdf`) must be replaced by the demo
  skill's. The command exits 6 when the verdict is not `passed`, and the report is still on
  stdout.
- An `assertion-error` agent run comes from a real pattern that exceeds the pattern time limit
  (`(a+)+$` on 32 `a` and `!`).
- The TypeScript grammar's time grows with the nesting depth on every line: 10,000 lines of 25
  `{` (260,000 bytes, under the 256 KiB highlighting bound) take about 20 s, 130,000 lines of one
  `{` about 160 s, while each line stays under the per-line limit. No probed input made Shiki
  throw (every listed language, long strings, comments, regexes, deep nesting).

## Lesson

A real path through the shipped code finds what a stand-in cannot (here: that the deadline
really terminates a worker stuck in a grammar, and that the server answers meanwhile). Look for
the real input or the real command first, and keep stand-ins for what no input can produce.

## How to apply

- For a browser check of agent output, run the built CLI with a fake `claude` from the test
  (`apps/web/e2e/real-capture.spec.ts`), clean its suite, run, job and fixture rows up in
  `afterAll`, and give the run a named timeout.
- To exercise the highlighting deadline on a page, use deeply nested braces in a `.ts` file;
  keep the line count low (thousands, not 100,000), since every line is rendered in the HTML and
  the RSC payload.
- Measure an input at two or three sizes before relying on it as "slow on every machine": the
  chosen one should exceed the bound by about ten times.
