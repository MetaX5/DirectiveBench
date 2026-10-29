---
title: A deterministic assertion must check the outcome, not one way of reaching it
date: 2026-10-29
tags: [benchmarking, assertions, d03]
source: .ai/runs/2026-10-29-d03-check-wp-block-development.md
---

# A deterministic assertion must check the outcome, not one way of reaching it

## Context

In the first real D03 check, the suite required a `deprecated` entry when an existing published
Gutenberg block got a new option. The goal was that old content stays valid. 6 of 12 runs failed the
check. The failed runs that were inspected kept the saved markup byte-identical while the option
is off. That also keeps old content
valid, and it is arguably the better fix. The assertion failed those runs anyway, and the false
failures were as large as the whole difference being measured.

## Lesson

A pattern or file check tests one implementation. When a goal has more than one valid
implementation, the check produces false failures. Those failures are noise in the score, and
they look like a regression or an improvement.

## How to apply

- Before writing an assertion, list the valid ways to meet the requirement. Check what they all
  share (the outcome). Use a `command` assertion, or wait for rubric grading (S3), when only
  running the result can show the outcome.
- Read the failed assertions of a first run against the agent's actual output before you trust
  a verdict.
