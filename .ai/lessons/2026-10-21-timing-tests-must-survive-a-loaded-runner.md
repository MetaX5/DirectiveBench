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
  with a bound of 4. Also force a GC (`collectGarbage()`) before each timed run.
