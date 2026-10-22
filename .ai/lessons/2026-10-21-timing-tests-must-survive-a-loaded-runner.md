---
title: Timing tests must survive a loaded CI runner
date: 2026-10-21
tags: [testing, ci, flaky]
source: .ai/runs/2026-10-21-flaky-timing-tests.md
---

# Timing tests must survive a loaded CI runner

## Context

Two tests failed on `main` and on the first Dependabot PRs while passing locally.
`reports timeout and cancellation when cancelled during the grace period` started a Node.js script
that ignores SIGTERM, with a 100 ms timeout: on a loaded runner Node.js had not installed its
handler yet, so SIGTERM killed it (`cancelled: false`, `signal: SIGTERM`). `parses pathological
input in linear time` bounded the total parse time at 5 s; it took ~0.3 s locally and 5.06 s on CI.
Both reproduced locally only with the CPU saturated (`yes > /dev/null` × 3 × nproc).

## Lesson

A test that races a child process's start-up against a timer, or bounds wall-clock time with a
fixed limit, is flaky on shared runners, where everything can run 10–20× slower.

## How to apply

- A child that must be in a state before a timer fires gets that state at once: `sh -c "trap ''
  TERM; …"` instead of a Node.js handler installed after start-up.
- Test linear time with a ratio — the same input at two sizes, fastest of a few runs — or with a
  bound orders of magnitude between the fixed and the broken code (milliseconds vs minutes).
- Reproduce a suspected timing flake under `yes > /dev/null` load before and after the fix.
- Before writing a ratio test, measure every input at three sizes. The first ratio version
  failed on CI at 10.8 against a bound of 8: the backtick-run input was not linear but grew with
  the size to the power 1.5 (ratio ~7.6 locally), which the parser has since fixed. A ratio near
  the bound is a finding, not noise to tune away.
- Normalise a size-ratio test by a linear baseline measured on the same inputs (update
  2026-10-22, PR #105). Once strings outgrow the CPU caches, even `split` plus `replace` grows
  ~16× for an 8× input, so a raw ratio bound of 10 failed on CI at 10.6 for a linear scanner.
  The ratio (scan growth ÷ baseline growth) is ~1 for linear code and ~6–8 for quadratic code,
  with a bound of 4. Also force a GC (`collectGarbage()`) once the inputs are built, so their
  garbage cannot land in a measurement (once, not before each sample: see below).
- Reproduce CI's capacity before pushing heavy tests: `taskset -c 0,1 pnpm test --force` runs every
  package's suite in parallel on two cores like the GitHub runner. PR #108's scan tests took under
  1.5 s alone but 5–24 s on CI (vitest's default 5 s timeout); creating 20 000 real files to hit a
  limit was replaced by a faked listing, timing tests take the fastest of three runs at small sizes,
  and heavy tests carry a named timeout. Never report CI as green without checking the current
  head (`gh pr checks`), not an earlier one (added 2026-10-22).
- Use the shared helper `test-support/linear-time.ts` (`expectLinearTime`) for every
  linear-time test instead of a hand-rolled ratio (added 2026-10-22, issue #114). Hand-rolled
  ratios had drifted apart (raw ratios against 12 or 30, a `+ 50 ms` slack, no GC, a 4× step where
  quadratic code only reaches 16 against a bound of 12) and failed on CI at 12.2, 13.0 and 16.9.
- Measure CPU time (`process.cpuUsage()`), not wall-clock time, in a ratio test. Under
  `taskset -c 0,1` with two `yes` processes and six parallel vitest runs, a first helper version
  with wall-clock samples (fastest of three, GC before each) measured a deliberately quadratic
  function at 2.0–3.7 and linear scanners at 4.2–4.9 (bound 4): the scheduler takes whole time
  slices away, unevenly. CPU time fixed that, with two more traps: a forced GC before every
  sample leaves background sweeping that is billed to the next short sample (quadratic measured
  ~3), so collect once after building the inputs; and the first samples of a process run before
  the JIT optimised the code, so discard one warm-up round. Prove a ratio helper both ways under
  load: linear stays ~1 and a deliberate quadratic stays ~8.
- A test that asserts outcomes rather than time still needs a named timeout when it does a lot
  of real work: an offset sweep over a file-backed database (20 ms alone) and a fake-git test
  spawning eight Node.js fakes (0.3 s alone) exceeded vitest's 5 s default under load.
