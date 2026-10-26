---
title: Test a hand-written parser against the reference implementation, not review by review
date: 2026-10-22
tags: [testing, parsing, markdown, dependencies, performance]
source: .ai/runs/2026-10-22-issue-110-markdown-tokenizer.md
---

# Test a hand-written parser against the reference implementation, not review by review

## Context

The Markdown scanner of the document assertions (SPEC-118 FR-118-41/43) began as line
heuristics. Four Codex review rounds on PR #105 each found new block-boundary bugs, and issue #110
two false PASSes (list marker padding, an HTML comment after a table). Replacing it with a library
was measured first: micromark and mdast-util-from-markdown are quadratic on documents with many
block quotes or list items (81 s for 128 KiB of `> q\n\n`), far outside NFR-118-02. markdown-it,
proposed as a test oracle, disagreed with cmark-gfm (GitHub) on 15 % of generated documents and
reports headings GitHub does not; micromark on 8 %. Rewritten after the CommonMark reference
algorithm and compared with recorded cmark-gfm readings of 5 000 generated documents, the scanner
matched all of them, while the old one differed on 2 752 and over-reported in 1 788.

## Lesson

A parser that must agree with another implementation is only as good as the comparison with it.
Write it after the published reference algorithm, compare it with the implementation users see
(here cmark-gfm, not a third-party library that is "probably the same"), and generate the inputs
— nested containers, padding, tabs, lazy lines, every block kind — instead of collecting cases
from reviews. Measure a library's worst case at the input limit before adopting it.

## How to apply

- Check a candidate oracle against the real reference on the generated corpus before trusting
  it; record where it differs.
- Record the reference's readings in a fixture with the generator's seed and a digest of the
  documents, so CI needs no reference parser and a changed generator fails loudly
  (`packages/benchmark-engine/scripts/cmark-gfm-corpus.mjs`).
- Where readers disagree, report less (fail safe) and say so in the spec.
- Shrink a failing generated document line by line before analysing it; compare with the
  reference on each candidate (`cmarkgfm` in a scratch venv).
- Time each candidate library on the adversarial shapes at the input limit on 2 cores
  (`taskset -c 0,1`) before writing integration code.
- When a review still finds a false pass, add its whole input class to the generator, not the one
  line (updated 2026-10-26, issue #116): PR #115's rounds fixed U+00A0, VT and FF at the places the
  reviewer tried, and generating those characters everywhere found a sibling at once (VT/FF before
  a row's leading pipe is an empty cell). Compare deliberate under-reports with an explicit,
  tested subset rule that still fails every over-report, never by leaving the case out of the
  corpus.
