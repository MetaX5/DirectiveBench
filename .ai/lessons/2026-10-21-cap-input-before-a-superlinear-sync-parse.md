---
title: Cap the input before a synchronous parse whose cost is superlinear
date: 2026-10-21
tags: [security, performance, parsing, runner]
source: .ai/runs/2026-10-21-issue-49-frontmatter-source-cap.md
---

# Cap the input before a synchronous parse whose cost is superlinear

## Context

`parseFrontmatter` handed the whole frontmatter block — up to the 1 MiB primary-file limit — to
`yaml`'s `parse`. Its duplicate-key check is quadratic in the keys of one mapping: 64 KiB of
`kN: 1` keys parsed in 0.2 s (a denser flow mapping of null keys in 0.65 s), 128 KiB in 1 s, 256 KiB in 3 s, so a 1 MiB block takes tens of seconds (~45 s extrapolated; the issue estimated ~90 s). The
parse is synchronous, so the runner's event loop stopped: no heartbeats (30 s stale threshold), no
cancellation, no SIGINT (issue #49). The existing limits did not help: the file-size limit was
sized for content, not for parse cost, and `MAX_FRONTMATTER_JSON_BYTES` runs after the parse.

## Lesson

A size limit chosen for storage is not a bound on CPU time when the work is superlinear in the
input. Any synchronous step on untrusted input needs its own named cap, checked **before** the
step runs and sized from a measurement of the worst case, not the typical one. Do not "fix" it by
turning off the expensive check (`uniqueKeys: false`) — that changes behaviour.

## How to apply

- For every parser or synchronous transform that sees untrusted input, measure its time at the
  input limit with a worst-case shape (many keys, deep nesting, many aliases), not real files.
- If it can block the event loop for more than a fraction of a second, add a named cap before it
  (`MAX_FRONTMATTER_SOURCE_BYTES`), treat over-cap input as the existing invalid-input case, and
  justify the value with the measurements in the code and the spec.
- In the regression test, mock the expensive call and assert it was **not** called for over-cap
  input, and check the boundary in the same unit the cap counts (UTF-8 bytes, not characters).
