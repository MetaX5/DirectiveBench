---
title: A test that needs a name missing from a static list constructs that name
date: 2026-11-19
tags: [testing, claude-code]
source: .ai/runs/2026-11-19-issue-278-reserved-names-2-1-325.md
---

# A test that needs a name missing from a static list constructs that name

## Context

The issue 275 run-time check tests used `ultrareview`, a real built-in from the 2.1.325
recording, as "a name the static reserved list misses". Refreshing the list (issue 278) added
`ultrareview`, so those tests would have hit the plan-time refusal instead and silently stopped
covering the run-time check.

## Lesson

When a test depends on a gap in a list that is meant to be refreshed from recordings, borrowing a
real recorded name ties the test to the list's current staleness. Construct the gap instead.

## How to apply

Derive a variant of the recording with the name replaced by an obviously synthetic one
(`newer-built-in`, `newerSessionStart()` in `packages/agent-adapters/test/claude-code/helpers.ts`),
assert that the static list does not hold it, and label it as constructed, not recorded.
