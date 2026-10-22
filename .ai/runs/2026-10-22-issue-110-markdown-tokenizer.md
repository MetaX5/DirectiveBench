---
title: 'Issue #110 — Markdown false-pass paths: tokenizer spike, then a GFM block scanner verified against cmark-gfm'
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: 'Issue #110; maintainer decisions (b) measure a tokenizer first, then (d) keep a hand-written scanner with a differential test'
status: in-progress
branch: fix/issue-110-markdown-tokenizer
specs: [SPEC-118, SPEC-108]
---

# Run: Issue #110 — Markdown false-pass paths

## Objective

Issue #110 reported two ways a wrong document passed a document assertion (SPEC-118
FR-118-41/43): list-marker padding (`-   ` read as content indentation 2) and an HTML comment
after a table delimiter (its lines read as table rows). Acceptance: both repros as scanner- and
assertion-level regression tests that fail on `main`; no false PASS; NFR-118-02 kept; 100 %
coverage; full gate.

## Plan

Phase 1 (maintainer decision (b)): measure `micromark` + GFM table extension and
`mdast-util-from-markdown` against NFR-118-02 on the 2-core CI emulation; switch only if they fit,
otherwise stop and report.

Phase 2 (maintainer decision (d), after the report): keep a hand-written scanner without a runtime
dependency; fix both repros; add a seeded differential (property-based) test against a reference
parser (markdown-it as a development dependency was proposed); fix every divergence or record it
as a fail-safe limit; record the decision and measurements.

Re-plan during phase 2: patching the heuristics did not converge, so the scanner was rewritten
after the CommonMark reference algorithm (container stack, leaf blocks, lazy continuation, tab
stops), with the GFM table extension tried last as cmark-gfm does. markdown-it turned out to be an
unreliable oracle (below), so the reference became cmark-gfm itself, recorded into a fixture.

## Decisions

- **No Markdown library at run time** — micromark/mdast are quadratic on ordinary documents
  (phase 1 table). Recorded in [ADR-0013](../decisions/0013-hand-written-gfm-block-scanner.md),
  accepted by the maintainer on 2026-10-22.
- **cmark-gfm, not markdown-it, as the differential reference** (deviation from the proposal):
  on 10 000 generated documents markdown-it differed from cmark-gfm on 1 533 and micromark on 805;
  markdown-it reports headings and rows GitHub does not (a table on a list item's first line read
  as a top-level table with the marker in the header cell; `>` indented four spaces read as a
  quote marker; tabs in nested quotes). Matching it would import those bugs. cmark-gfm readings
  are recorded once by `packages/benchmark-engine/scripts/cmark-gfm-corpus.mjs` (Python
  `cmarkgfm` 2025.10.22, development only) into `test/fixtures/cmark-gfm-corpus.json`; CI needs no
  reference parser and no dependency was added. markdown-it was removed again. The maintainer
  confirmed cmark-gfm as the reference on 2026-10-22.
- **Fail safe where GFM readers disagree or a construct is not modelled:** a table without a pipe
  in its header or delimiter row is read but not reported (cmark-gfm reads `Role\n|---|` as a
  table, markdown-it does not); a setext heading whose paragraph may start with a link reference
  definition is not reported; nesting deeper than `MAX_MARKDOWN_NESTING` = 32 ends the scan.
- **Follow cmark-gfm where it differs from commonmark.js:** an HTML block of kind 7 may start on a
  lazy continuation line; a lazy table-header line keeps its indentation (`   | a |` has an empty
  first cell); no table opens later in a paragraph that already held a delimiter row.

## Work performed

1. Phase 1 spike (commit `7142103`, numbers below) — stopped and reported.
2. Merged `origin/main` (PR #112 and others; no conflict in the owned files).
3. Rewrote the block scanner in `packages/benchmark-engine/src/markdown.ts`: `Cursor` with tab
   stops and partly consumed tabs; container stack of block quotes and list items (marker padding
   1–4, 5+ → indented code after one space, an item opening with at most one blank line,
   interrupt rules); leaves for paragraphs (lazy continuation), fenced and indented code, HTML
   blocks of kinds 1–7 (sticky single-class regex runs, no backtracking), GFM tables; blank-line
   fast path; `MAX_MARKDOWN_NESTING`. Public API, `MarkdownTableRow.text`, the evaluators, limits,
   redaction and the worker design are unchanged.
4. Tests: `test/markdown-corpus.ts` (seeded generator + comparable form),
   `test/markdown-reference.test.ts` (5 000 documents vs recorded cmark-gfm readings, plus a
   generator digest), `test/fixtures/cmark-gfm-corpus.json`, the two repros at scanner and
   assertion level, cmark-gfm-checked cases for padding/tabs/HTML kinds/tables/nesting, eight new
   adversarial linearity shapes. Three old expectations were non-GFM and changed: `    ---` after
   a table is indented code (ends the table), `- | -` is a list item, not a delimiter row, and a
   table header on a lazy line of a list item's paragraph is no table; the table in a block quote
   is now found.
5. Docs: SPEC-118 FR-118-41/43, NFR-118-02 and §20; ADR-0013; lesson; `.prettierignore` entry for
   the generated fixture.

## Verification

### Phase 1 — library measurements (2 cores, `taskset -c 0,1`, Node 24.21.0)

Versions: `micromark` 4.0.3, `micromark-extension-gfm-table` 2.1.2, `mdast-util-from-markdown`
2.1.0, `mdast-util-gfm-table` 2.0.0, `markdown-it` 15.0.3. Parse/scan only; "skipped" = the
previous size already exceeded 5 s.

| Shape (repeated to size) | Implementation | 128 KiB | 512 KiB | 2 MiB |
| --- | --- | --- | --- | --- |
| realistic (headings, prose, table, lists, fence, setext, comment) | previous scanner | 26 ms | 56 ms | 228 ms |
| | micromark (inline off) | 1 016 ms | 9 285 ms | skipped |
| | mdast + gfm-table | 1 026 ms | 9 567 ms | skipped |
| | markdown-it (full) | 182 ms | 562 ms | 1 478 ms |
| | markdown-it (block rules only) | 81 ms | 193 ms | 865 ms |
| realistic + a block quote per block | previous scanner | 10 ms | 48 ms | 117 ms |
| | micromark (inline off) | 1 180 ms | 13 682 ms | skipped |
| | mdast + gfm-table | 1 297 ms | 15 327 ms | skipped |
| | markdown-it (block only) | 86 ms | 121 ms | 850 ms |
| `> q\n\n` (quotes separated by blank lines) | previous scanner | 33 ms | 74 ms | 241 ms |
| | micromark (inline off) | **80 907 ms** | skipped | skipped |
| | mdast + gfm-table | **135 212 ms** | skipped | skipped |
| | markdown-it (block only) | 83 ms | 277 ms | 1 072 ms |
| `- item\n  cont\n\n` (list items separated by blank lines) | previous scanner | 4 ms | 14 ms | 67 ms |
| | micromark (inline off) | 586 ms | 1 955 ms | **44 201 ms** |
| | mdast + gfm-table | 2 309 ms | 5 270 ms | skipped |
| | markdown-it (block only) | 123 ms | 277 ms | 1 037 ms |
| table rows (one 2-column table) | previous scanner | 9 ms | 28 ms | 95 ms |
| | micromark (inline off) | 457 ms | 1 736 ms | 6 454 ms |
| | mdast + gfm-table | 526 ms | 2 026 ms | 7 349 ms |
| | markdown-it (block only) | 43 ms | 109 ms | 449 ms |

Scaling probe (micromark): `para\n\n- a\n\npara\n\n` took 724 / 2 413 / 9 849 / 39 957 ms at
32 / 64 / 128 / 256 KiB — ×4 per doubling. Cause: `micromark/lib/initialize/document.js`
(`exitContainers` / `closeFlow`) walks `self.events` backwards on every container exit.

### Phase 2 — the new scanner

- Differential: 5 000 recorded documents (seed 110) equal cmark-gfm; the previous scanner differs
  on 2 752 and reports extra headings or rows in 1 788. Offline on fresh seeds 2026 and 7 (20 000
  each): 0 and 1 differences — the one is inline HTML text inside a heading, which the comparable
  form does not compare.
- Both repros fail on the previous scanner and pass now (`markdown.test.ts`,
  `document-assertions.test.ts`); 13 tests in total fail on the previous scanner.
- 2 MiB, 2 cores (best of 3): scan of the realistic document 58–101 ms (previous 56–94 ms);
  `> q\n\n` 191 ms (111); list items 129 ms (67); 16 nested items + 2 MiB of blank lines 263 ms
  (153); HTML tag lines 54 ms; one 2 MiB tag line 34 ms; deep one-line nesting stops at
  `MAX_MARKDOWN_NESTING` (0–1 ms). Assertions on the 2 MiB test document including worker
  start-up: `markdown-sections` 103 ms, `required-phrases` 53 ms, `markdown-table-value` 91 ms.
- Linearity tests (25 shapes) pass under `taskset -c 0,1` with `yes > /dev/null` on the same
  cores.
- Gate after merging `origin/main` (PR #113): `pnpm format:check && pnpm lint && pnpm typecheck &&
  pnpm test` — pass, 100% coverage (benchmark-engine 280 tests).

Not verified: Windows (no path or process changes); behaviour of inline content (never parsed).

## Problems and deviations

- Codex adversarial review (PR #115, round 1), high: a link reference definition with a multi-line
  label (`[foo\nbar]: /url\n---`, CommonMark example 541) was reported as the heading
  `[foo bar]: /url` — a false pass. The fail-safe guard now looks for `]:` on any line of a
  paragraph that starts with `[`; regression tests at scanner and assertion level fail on the
  previous code. Link definitions stay out of the differential corpus on purpose: the scanner does
  not parse them and under-reports such headings (fail-safe), which an equality comparison with
  cmark-gfm would flag.
- Codex review round 2, two findings, both reproduced against cmarkgfm 2025.10.22 and fixed red
  first (5 new tests fail on the previous code):
  - high: after the suppressed underline the paragraph was closed, so `[foo\nbar]: /url\n---\n2.
    # Fake` reported `Fake`; cmark-gfm reads `---` as paragraph text after definitions only, where
    `2.` cannot interrupt. The paragraph now stays open (with `noTable`), which reports no block
    either cmark-gfm reading lacks (definitions only, or definitions plus a heading).
  - medium: cmark-gfm's table limits (`MAX_AUTOCOMPLETED_CELLS` 0x80000 filled-in cells per table,
    at most 65 535 cells per row, from `extensions/table.c`) were not mirrored, so a sparse
    1 000-column table kept rows that GitHub renders as paragraph text. The scanner now counts
    filled-in cells without materialising them and ends the table as cmark-gfm does; boundaries
    (524 vs 525 sparse rows, 65 535 vs 65 536 cells) match the empirical cmark-gfm output.
  - Neither case went into the recorded corpus: link definitions are deliberately not compared
    (fail-safe under-reporting), and the limit cases need documents of hundreds of KiB that the
    generator does not produce; both are pinned by direct tests instead.

- An earlier single-threaded spike of the realistic 2 MiB document with micromark took 32 s, which
  led to the per-shape breakdown.
- The Python HTML parser used for cmark-gfm readings swallowed everything after a raw `<!--`;
  rendering with cmark-gfm's safe mode (raw HTML as a placeholder comment) fixed the comparison.
- markdown-it was added as a development dependency and removed again (see Decisions).

## Lessons recorded

- [Test a hand-written parser against the reference implementation, not review by review](../lessons/2026-10-22-test-a-parser-against-the-reference-not-reviews.md)

## Follow-ups

- Heading levels are not compared (the scan does not report them; no assertion uses them).
- Link reference definitions are not parsed (fail-safe: such setext headings are not reported).
