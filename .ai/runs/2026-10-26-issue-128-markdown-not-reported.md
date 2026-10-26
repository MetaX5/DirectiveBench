---
title: 'Issue #128 - the Markdown scanner reports what it did not read, and the differential test becomes exact'
date: 2026-10-26
agent: Claude Code / claude-opus-5-5
trigger: 'Issue #128 (nit from the review of PR #127), assigned by the maintainer session'
status: in-progress
branch: feat/issue-128-markdown-not-reported
specs: [SPEC-118]
---

# Run: Issue #128 - Markdown scanner `notReported`

## Objective

Per issue #128: `MarkdownScan.notReported` lists the deliberate gaps (`link-definition-underline`,
`nesting-limit`, `pipeless-table`) with 1-based lines; the differential test drops its
document-wide `]:` switch and its one-column wildcard and compares against cmark-gfm's reading of
the prefix before a stop line and matches pipe-less tables by header line; `markdown-sections` and
`markdown-table-value` show the gaps in details and failing messages.

## Plan

1. Red: scanner tests for `notReported`; assertion tests for details and messages; regression
   tests that a scanner stopping one block early, or dropping a piped one-column table, fails the
   differential check.
2. Scanner field; recorder records prefix readings; `readingDifference` exact; re-record.
3. Assertions; SPEC-118 FR-118-41/43 and §20; ADR-0013 Consequences.
4. Gate, PR, Codex rounds (max 4), CI.

## Decisions

- **Prefixes are chosen by the scanner, and the test checks the choice.** The recorder runs
  `scanMarkdown` to learn which prefixes to record (`prefixLineCounts`: lines before a stop, lines
  up to a pipe-less table's delimiter row). To keep that from being circular, the test requires
  the recorded prefix line counts of every document to equal the ones the current scanner needs,
  so a scanner that moves its stop line has no reading to compare with and fails.
- **A pipe-less table is identified through cmark-gfm's prefix reading, not source positions**
  (which cmark-gfm 2025.10.22 reports unreliably for tables in paragraphs, run log of #116): the
  reading of lines 1 to L+1 must end with a one-column table without rows, and that table's index
  is the one left out of the full (or stop-prefix) reading. A table named twice, or a prefix that
  does not end so, is a difference.
- **Details only when something was not read; message sentences only on failure.** Passing
  messages and the details of fully read documents are unchanged. `markdown-sections` uses only
  the stop (a pipe-less table hides no heading); `markdown-table-value` uses all entries. Details
  list the stop first and at most `MAX_LISTED_GAPS` = 20 entries, with `notReportedCount`
  (a 2 MiB document can hold some 350 000 pipe-less tables; the scanner field itself stays
  complete, bounded by the number of tables plus one).
- **Wording:** "The document was checked only before line N: ..." rather than the issue's "up to
  line N", since line N itself is not read (a nesting stop can be line 1). No en or em dashes.

## Work performed

1. Red: scanner tests (`markdown.test.ts`, "scanMarkdown notReported (issue #128)") failed on
   the missing field; then `src/markdown.ts`: `notReported` set at the two nesting stops, the
   link-definition stop and the pipe-less table branch; a linear-time shape of pipe-less tables.
2. `test/markdown-corpus.ts`: `prefixLineCounts` and an exact `readingDifference(scanner,
   reference)`; `scripts/cmark-gfm-corpus.mjs` records `prefixReadings`; fixture re-recorded with
   cmarkgfm 2025.10.22 (full readings unchanged, 1 330 prefix readings for 1 300 documents).
   `markdown-reference.test.ts`: exact corpus check per document, coverage of both gaps, and
   constructed regressions.
3. Red: assertion tests (`document-assertions.test.ts`, "what the Markdown scan did not read");
   then `describeGaps` in `src/document-assertions.ts`. Three existing tests of link-definition
   documents now expect the stop sentence.
4. SPEC-118 FR-118-41/43 and §20, ADR-0013 Decision 3 and Consequences.

## Verification

| Check | Result |
| --- | --- |
| Red first: scanner tests before the field | 5 fail |
| Red first: assertion tests before `describeGaps` | 4 fail |
| Red first: previous `readingDifference` on the constructed regressions (scratch script) | accepted all 470 scans stopped one block early and all 355 scans missing a piped one-column table |
| New `readingDifference` on the recorded corpus | 10 000 / 10 000 exact |
| Constructed regressions in `markdown-reference.test.ts` | fail on every affected document (one block early, earlier stop line, dropped piped one-column table) |
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | pass, 7/7 tasks, 100 % coverage (benchmark-engine 424 tests) |
| `pnpm build && pnpm verify:pack` | pass |
| Linear-time shapes for pipe-less tables and link definitions under `taskset -c 0,1` with two `yes` | pass |

Not verified: Windows (no platform-specific code); the web UI shows details as stored JSON and
was not changed.

## Problems and deviations

- A first mutation test (scanner stops at an earlier line) passed on one corpus document whose
  earlier stop line happened to need a prefix recorded for a pipe-less table; the per-document
  check now compares the recorded prefix line counts with the needed ones, which catches it.

## Lessons recorded

- Updated [Test a hand-written parser against the reference implementation, not review by
  review](../lessons/2026-10-22-test-a-parser-against-the-reference-not-reviews.md): let the
  parser name where it reports less, record the reference's reading of exactly that part, and
  test that the recorded set equals the needed set.

## Follow-ups

- Heading levels are still not compared, and link reference definitions are still not parsed
  (the stop covers 816 of the 10 000 recorded documents).
