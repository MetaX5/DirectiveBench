---
title: 'Issue #110 — measure a CommonMark/GFM tokenizer against NFR-118-02 before replacing the Markdown scanner'
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: 'Issue #110, maintainer decision (b): replace the hand-written scanner with micromark + GFM, measured first'
status: aborted
branch: fix/issue-110-markdown-tokenizer
specs: [SPEC-118, SPEC-108]
---

# Run: Issue #110 — tokenizer spike (stopped at the measurement gate)

## Objective

Maintainer decision (b) on issue #110: replace the block scanner in
`packages/benchmark-engine/src/markdown.ts` with a spec-compliant CommonMark + GFM tokenizer
(`micromark` + `micromark-extension-gfm-table`, or `mdast-util-from-markdown` +
`mdast-util-gfm-table`) — **only if** it fits NFR-118-02 (2 MiB in < 200 ms target; the CI test
bounds one evaluation at 5 s). Otherwise stop and report the numbers; fallback (a), fixing the
two repros in the existing scanner, starts only after that report.

## Plan

1. Prototype the scan on `micromark`'s event stream (`parse` → `postprocess`, GFM table
   extension, all inline constructs disabled so only block structure is tokenized; headings from
   `atxHeadingText`/`setextHeadingText` data tokens, tables from `tableRow`/`tableHeader`/
   `tableData`/`tableContent`).
2. Benchmark it, `mdast-util-from-markdown` + `mdast-util-gfm-table`, and (for reference)
   `markdown-it` against the current scanner on the 2-core CI emulation
   (`taskset -c 0,1 node --expose-gc`, best of 2–3 runs after a GC) at 128 KiB, 512 KiB and
   2 MiB.
3. Decide go / stop.

## Decisions

- **Stopped before switching** (as instructed): neither micromark nor mdast fits the budget —
  both are superlinear on ordinary documents (see below). No dependency was added, no code was
  changed. The spike scripts live outside the repository.

## Work performed

- Confirmed both repros of the issue on `main` (0030ebd): `"-   ```\n  ```\n# Risks\n```"` →
  heading `Risks` (wrong; GFM: code); `"| Role | Hours |\n|---|---|\n<!--\n| Backend API | 24 |\n-->"`
  → body rows `<!--`, `Backend API / 24`, `-->` (wrong; GFM: the HTML block ends the table).
  The micromark prototype returns the GFM answers for both (no heading; a table without rows).
- Benchmarks below.

## Verification

Versions: `micromark` 4.0.3, `micromark-extension-gfm-table` 2.1.2, `mdast-util-from-markdown`
2.1.0, `mdast-util-gfm-table` 2.0.0, `markdown-it` 15.0.3; Node 24.21.0;
`taskset -c 0,1`. Times are parse/scan only (no worker, no file read). "skipped" = the previous
size already exceeded 5 s.

| Shape (repeated to size) | Implementation | 128 KiB | 512 KiB | 2 MiB |
| --- | --- | --- | --- | --- |
| realistic (headings, prose, table, lists, fence, setext, comment) | current scanner | 26 ms | 56 ms | 228 ms |
| | micromark (inline off) | 1 016 ms | 9 285 ms | skipped |
| | mdast + gfm-table | 1 026 ms | 9 567 ms | skipped |
| | markdown-it (full) | 182 ms | 562 ms | 1 478 ms |
| | markdown-it (block rules only) | 81 ms | 193 ms | 865 ms |
| realistic + a block quote per block | current scanner | 10 ms | 48 ms | 117 ms |
| | micromark (inline off) | 1 180 ms | 13 682 ms | skipped |
| | mdast + gfm-table | 1 297 ms | 15 327 ms | skipped |
| | markdown-it (block only) | 86 ms | 121 ms | 850 ms |
| `> q\n\n` (quotes separated by blank lines) | current scanner | 33 ms | 74 ms | 241 ms |
| | micromark (inline off) | **80 907 ms** | skipped | skipped |
| | mdast + gfm-table | **135 212 ms** | skipped | skipped |
| | markdown-it (block only) | 83 ms | 277 ms | 1 072 ms |
| `- item\n  cont\n\n` (list items separated by blank lines) | current scanner | 4 ms | 14 ms | 67 ms |
| | micromark (inline off) | 586 ms | 1 955 ms | **44 201 ms** |
| | mdast + gfm-table | 2 309 ms | 5 270 ms | skipped |
| | markdown-it (block only) | 123 ms | 277 ms | 1 037 ms |
| table rows (one 2-column table) | current scanner | 9 ms | 28 ms | 95 ms |
| | micromark (inline off) | 457 ms | 1 736 ms | 6 454 ms |
| | mdast + gfm-table | 526 ms | 2 026 ms | 7 349 ms |
| | markdown-it (block only) | 43 ms | 109 ms | 449 ms |

Scaling probe (micromark, inline off, cores 4–5): `para\n\n- a\n\npara\n\n` took 724 ms /
2 413 ms / 9 849 ms / 39 957 ms at 32 / 64 / 128 / 256 KiB — ×4 per doubling, i.e. quadratic
(extrapolated ≈ 40 min at 2 MiB). The cost is in `micromark/lib/initialize/document.js`
(`exitContainers` / `closeFlow`): every container exit walks `self.events` backwards
(`while (indexBeforeFlow--)`) to the last `chunkFlow` exit, so a document with many block quotes
or list items separated by other blocks is O(containers × events).

Not verified: CI timings (no PR was opened); `markdown-it` conformance to GFM tables (only timed).

## Problems and deviations

- An earlier single-threaded spike of the realistic 2 MiB document with micromark took 32 s, which
  led to the per-shape breakdown above.

## Lessons recorded

None yet — the "hand-written parser saga" lesson waits for the maintainer's choice between
fallback (a) and an alternative tokenizer.

## Follow-ups

- Maintainer decision needed: (a) fix the two repros in the existing scanner (the documented
  fallback), or (c) evaluate `markdown-it` (CommonMark-compliant, tables built in, linear here;
  block-only 0.45–1.07 s at 2 MiB on 2 cores — within the 5 s CI bound but 2–5× over the 200 ms
  target, and its table rules are not GFM-spec tested).
