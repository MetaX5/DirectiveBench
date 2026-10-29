---
title: Shiki's per-line time limit does not bound one slow regex match, makes output depend on machine speed, and its line-length limit is exclusive
date: 2026-10-29
tags: [web, security, performance, dependencies]
source: .ai/runs/2026-10-29-spec-123-design-system-components.md
---

# Shiki's per-line time limit does not bound one slow regex match, makes output depend on machine speed, and its line-length limit is exclusive

## Context

Implementing SPEC-123 D20 (server-side syntax highlighting with Shiki 4.5, JavaScript regex
engine, `apps/web/lib/syntax-highlight.ts`). Two Shiki options did not behave as their names
suggest:

- `tokenizeMaxLineLength: N` leaves a line plain when `line.length >= N`
  (`@shikijs/primitive`), so a line of exactly N characters is not highlighted. The spec says
  lines *longer than* 10,000 characters stay plain.
- `tokenizeTimeLimit` (500 ms) is checked by vscode-textmate between regex matches. One match
  that is slow is not interrupted: a TypeScript or JavaScript line made of one 9,000-character
  identifier took about 1.6 s alone, three such lines about 4.8 s (JSON, PHP, Python, YAML and
  Markdown stayed under 0.5 s). The JavaScript engine's identifier patterns grow roughly with
  the square of the line length.

- Update 2026-10-29 (PR #155 CI): the committed Storybook fixtures matched locally but not on
  the 2-core runner. The PHP sample's first line came out as one `<?php` token instead of `<?`
  and `php`. The time limit's clock (`Date.now()` in vscode-textmate) also counts the lazy
  compilation of the grammar's regular expressions on first use, so a cold grammar on a slow
  machine passes 500 ms inside the first line and the rest of it is left as one token.
  Reproduced deterministically with `tokenizeTimeLimit: 1` on a fresh highlighter (first pass
  `<?php`, second pass `<?` + `php`) and with a `Date.now` stub that advances a second per read.
  In the same CI run, a size-bound test of 256 KiB of code took 13.8 s (5 s default timeout);
  locally a one-identifier tail line of 6,000 characters alone took 0.7 s.

## Lesson

- Pass `tokenizeMaxLineLength: limit + 1` when "longer than the limit" is meant, and test the
  exact boundary alone, before and after another line.
- Do not treat `tokenizeTimeLimit` as a bound on a request. The real worst case is about
  (bytes / line length) lines times the cost of one pathological line just under the length
  limit. A 256 KiB file of such lines can take tens of seconds.

- Token boundaries under a time limit are not deterministic. Anything compared exactly
  (fixtures, token assertions) must run with the limit off (`tokenizeTimeLimit: 0`; in this repo
  `highlightLines(text, language, { lineTimeLimitMs: SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT })`).
- A bound test needs input that is cheap to process: lines over the length limit are skipped
  by Shiki, a long single identifier under it is not.

## How to apply

- When bounding highlighting work (NFR-123-07), measure a pathological long-identifier line in
  each listed grammar at a few lengths below the line limit, not only a typical file.
- A real bound needs a budget across the whole file (for example tokenizing line by line with
  `grammarState` and stopping at a total time), or a lower line limit; both change SPEC-123
  constants and need the maintainer's decision.
- Never compare highlighter output computed with the shipped time limit; give exact-token tests
  and generated fixtures the no-limit option, and keep one test that the default passes the
  shipped limit. Simulate a slow runner with a `Date.now` stub, not by hoping CI is slow.
- Assert speed with `expectLinearTime` (CPU-time growth), not a wall-clock bound.
