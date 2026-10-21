---
title: A regex for a delimited span must not match its own opening delimiter inside
date: 2026-10-21
tags: [security, regex, performance]
source: .ai/runs/2026-10-21-codeql-alerts.md
---

# A regex for a delimited span must not match its own opening delimiter inside

## Context

CodeQL (`js/polynomial-redos`) flagged the Markdown link pattern `\[[^\]]*\]\(([^)\s]+)\)` and
the private-key pattern `BEGIN[\s\S]*?END` in `@directivebench/core`. On a run of `[` (or `[](`)
without a closing `)`, or of BEGIN markers without an END, the engine rescans to the end of the
text from every opener: about 7 minutes for 1 MiB of `[` (the primary-file limit) and about 30
minutes for 10 MiB of BEGIN markers (the command-output limit).

## Lesson

If the body of a span pattern can contain the span's opener, every failed opener costs a scan to
the end, which is quadratic. Excluding the opener from the body makes each attempt stop where the
next one starts; a span whose end may be missing (`[\s\S]*?END`) is better found with two
searches that stop at the first opener without an end.

## How to apply

- Write the body class so it excludes the opening delimiter (`[^[\]]*`, `(?:[^)\s\]]|\](?!\())+`).
- For BEGIN…END blocks use `exec` for BEGIN, then for END from there, and stop when END is missing.
- Check equivalence against the old pattern on edge cases, and add a test with input of the
  maximum allowed size whose bound is orders of magnitude from the old time.
