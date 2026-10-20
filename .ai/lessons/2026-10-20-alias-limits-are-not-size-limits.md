---
title: An alias limit is not a size limit — cap the expanded output itself
date: 2026-10-20
tags: [parsing, security, limits]
source: .ai/runs/2026-10-20-pr-44-review-fixes.md
---

# An alias limit is not a size limit — cap the expanded output itself

## Context

PR #44 pinned `yaml`'s `maxAliasCount` (100) as `MAX_FRONTMATTER_ALIAS_COUNT` and the code comment
and SPEC-102 claimed it bounded alias expansion. The independent review at `2d668f3` measured a
~1 MB `SKILL.md` (`a: &a "<1 MB string>"`, then `b: [*a ×99]`): it parsed without error and
became ~100 MB of JSON in `parsed_metadata`. Under the 256 MiB per-scan content limit, an
untrusted repository could make one scan store tens of GB.

## Lesson

`yaml` weights an alias by the number of aliases inside the node it repeats, so an alias of a
scalar costs 1 whatever the scalar's length. The limit stops exponential "billion laughs" nesting,
not linear repetition of a large node. A per-input byte limit (here the 1 MiB primary file) does
not bound the output either: 100 aliases make it ~100×. And a per-item output cap alone does not
bound a batch: many small items can each expand to the cap.

## How to apply

- Never document a parser's alias, depth or node-count option as a size bound; measure the case
  "one large node, many aliases" before claiming one.
- Cap the size of what you store (`MAX_FRONTMATTER_JSON_BYTES`, counted as the exact UTF-8 bytes
  of the serialised form) inside the walk that already visits every node, re-walking shared nodes
  once per alias and stopping as soon as the budget is spent, so the check costs at most the cap.
- Count the expanded output in the batch-wide budget too (`maxScanBytes` counts frontmatter JSON).
- Test the boundary exactly (at the limit accepted, one byte more rejected) and the hostile case at
  full scale against the old code.

## Also seen in

- PR #50 (issue #17): the Markdown preview capped its *input* at 200 000 characters, but padding
  every table row to the header's width turned a 104 KB file into 50 million cells (4.3 s to
  parse, gigabytes of HTML). The fix keeps each row's own cells, so the output is never larger
  than the input; `apps/web/test/markdown.test.ts` checks the cell count of that input.
