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
- Reproduce CI's capacity before pushing heavy tests: `taskset -c 0,1 pnpm test --force` runs every
  package's suite in parallel on two cores like the GitHub runner. PR #108's scan tests took under
  1.5 s alone but 5–24 s on CI (vitest's default 5 s timeout); creating 20 000 real files to hit a
  limit was replaced by a faked listing, timing tests take the fastest of three runs at small sizes,
  and heavy tests carry a named timeout. Never report CI as green without checking the current
  head (`gh pr checks`), not an earlier one (added 2026-10-22).
