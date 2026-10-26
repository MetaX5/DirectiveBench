# ADR-0013: Read Markdown with a hand-written GFM block scanner, verified against cmark-gfm

- **Status:** Accepted (maintainer decision 2026-10-22)
- **Date:** 2026-10-22
- **Deciders:** Project maintainer (option (d) on issue #110; pending review of this record)
- **Related:** [SPEC-118](../specs/2026-10-22-benchmark-own-skills-s1.md) FR-118-41, FR-118-43,
  NFR-118-02 and §20; [SPEC-108](../specs/2026-10-14-benchmark-definition-format.md);
  [ADR-0005](0005-custom-benchmark-engine.md); run log
  [2026-10-22-issue-110-markdown-tokenizer](../runs/2026-10-22-issue-110-markdown-tokenizer.md)

## Context

The document assertions `markdown-sections` and `markdown-table-value` (SPEC-118 §6.5) grade
Markdown an agent wrote. A heading or table row the grader reports where GitHub's renderer has none
is a false PASS. The first scanner (PR #105) was a set of line heuristics; four Codex review rounds
each found new block-boundary bugs (fences in containers, unclosed fences, table bodies, list
padding, a comment after a table — issue #110). The scanner runs on the runner thread over up to
2 MiB per file and must stay linear (NFR-118-02: < 200 ms target; the CI test bounds it at 5 s).

## Decision

1. **No Markdown library at run time.** `packages/benchmark-engine/src/markdown.ts` implements the
   block phase of the CommonMark reference algorithm ("A parsing strategy" in the CommonMark spec,
   as in commonmark.js and cmark): a stack of open block quotes and list items, one open leaf
   (paragraph, fenced or indented code, HTML block of kinds 1–7, GFM table), lazy continuation,
   tab stops with partly consumed tabs, and the GFM table extension tried after every other block
   start, as cmark-gfm does. Inline content is never parsed. Where cmark-gfm and the CommonMark
   reference differ, the scanner follows cmark-gfm (GitHub), e.g. an HTML block of kind 7 may start
   on a lazy continuation line, and cmark-gfm's table limits (65 535 cells per row, 524 288
   filled-in cells per table) end a table as they do on GitHub.
2. **Fail safe where readers disagree.** Where GFM readers differ or the scanner does not model a
   construct, it reports less, never more: a table without a pipe in its header or delimiter row is
   read (its lines are no paragraph) but not reported; a setext heading whose paragraph may start
   with a link reference definition ends the scan (nothing below it is reported); a document
   nested deeper than
   `MAX_MARKDOWN_NESTING` (32) ends the scan there.
3. **Verified differentially against cmark-gfm.** A seeded generator builds container-heavy
   documents (nested block quotes and list items with varied marker padding, tabs and lazy lines;
   fences, indented code, every HTML block kind, tables, setext and ATX headings). Their readings by
   cmark-gfm are recorded once with `packages/benchmark-engine/scripts/cmark-gfm-corpus.mjs`
   (Python `cmarkgfm`, development only) into `test/fixtures/cmark-gfm-corpus.json`; the unit test
   requires the scanner to match all of them. CI needs no reference parser. Since issue #116 the
   generator also emits the characters on which cmark-gfm's whitespace differs from JavaScript's
   (U+00A0, line tabulation, form feed at line ends, after markers, in delimiter rows and after
   tags), lone-pipe lines, leading byte order marks and link reference definitions, in containers.
   The comparison stays exact for everything the scanner reports; only the deliberate
   under-reports of point 2 are compared as "scanner ⊆ cmark-gfm" by a narrow, tested rule
   (`readingDifference` in `test/markdown-corpus.ts`): after a link definition the headings and
   tables may stop early but stay a prefix, and a missing table must have one column (a table
   without a pipe has one).

## Alternatives considered

- **micromark + `micromark-extension-gfm-table`, or `mdast-util-from-markdown`** (maintainer option
  (b)). Measured on 2 cores (`taskset -c 0,1`): a realistic 512 KiB document took 9.3 s (old
  scanner: 56 ms), 128 KiB of `> q\n\n` took 81 s (mdast: 135 s), 2 MiB of list items separated by
  blank lines 44 s. Every container exit walks the whole event list backwards
  (`micromark/lib/initialize/document.js`), so documents with many quotes or list items are
  quadratic. Rejected: far outside NFR-118-02, and it would bring a runtime dependency into the CLI
  bundle.
- **markdown-it as the test oracle** (the maintainer's first choice for the differential test).
  On 10 000 generated documents it disagreed with cmark-gfm on 1 533 (micromark: 805) — tables on
  a list item's first line read as top-level tables with the marker in the header cell, `>` markers
  indented four spaces read as quotes, tabs in nested quotes — and it reports headings and table
  rows GitHub does not. Requiring the scanner to match it would import those bugs. Rejected in
  favour of recorded cmark-gfm readings; no development dependency was added.
- **Keep patching the heuristics.** Each review round found new boundaries; without a reference
  there is no end to it. Rejected.

## Consequences

- The scanner is about 500 lines that mirror a published algorithm, so reviews compare it with
  the reference instead of reasoning about each boundary; the corpus catches regressions.
- On the recorded corpus (5 000 documents, seed 110) the scanner equals cmark-gfm; offline runs on
  40 000 documents from two other seeds found no difference in block structure (one in the text of
  inline HTML inside a heading, which is not compared). The old scanner
  differed on 2 752 of the 5 000 and reported extra headings or rows in 1 788.
- Issue #116 (2026-10-26): the extended corpus (10 000 documents, seed 110) found one more
  over-report class: cmark-gfm reads a row from the first character after spaces and tabs, so a
  line tabulation or form feed before a leading pipe is an empty first cell (a header one cell
  wider, no delimiter row, a body row shifted by a column, and a line of form feeds is a row). It
  is fixed; 8 888 readings are equal and 1 112 differ only by the deliberate under-reports. A lazy
  `   |` header is now reported as cmark-gfm's one empty cell instead of being left out.
  Offline runs on 80 000 documents from four other seeds found no difference in block structure
  (three in inline markup inside a heading text: raw inline HTML spanning lines, `*\v*`
  emphasis).
- Throughput stays linear: a realistic 2 MiB document scans in about 60–100 ms on 2 cores;
  adversarial shapes (16 nested items then 2 MiB of blank lines, 2 MiB of HTML tag lines) stay
  below 300 ms.
- Changing the generator requires regenerating the corpus with Python and `cmarkgfm`
  (`pip install cmarkgfm==2025.10.22`); the test detects a changed generator by a digest.
- Known differences, all fail-safe: tables without pipes, link reference definitions before a
  setext heading, nesting deeper than 32 containers.
