---
title: Shiki's per-line time limit does not bound one slow regex match, and its line-length limit is exclusive
date: 2026-10-29
tags: [web, security, performance, dependencies]
source: .ai/runs/2026-10-29-spec-123-design-system-components.md
---

# Shiki's per-line time limit does not bound one slow regex match, and its line-length limit is exclusive

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

## Lesson

- Pass `tokenizeMaxLineLength: limit + 1` when "longer than the limit" is meant, and test the
  exact boundary alone, before and after another line.
- Do not treat `tokenizeTimeLimit` as a bound on a request. The real worst case is about
  (bytes / line length) lines times the cost of one pathological line just under the length
  limit. A 256 KiB file of such lines can take tens of seconds.

## How to apply

- When bounding highlighting work (NFR-123-07), measure a pathological long-identifier line in
  each listed grammar at a few lengths below the line limit, not only a typical file.
- A real bound needs a budget across the whole file (for example tokenizing line by line with
  `grammarState` and stopping at a total time), or a lower line limit; both change SPEC-123
  constants and need the maintainer's decision.
