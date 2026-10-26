---
title: 'Issue #116 — extend the Markdown differential corpus with BOM, control whitespace, lone pipes and link definitions'
date: 2026-10-26
agent: Claude Code / claude-opus-5-5
trigger: 'Issue #116 (follow-up of the Codex rounds on PR #115), assigned by the maintainer session'
status: completed
branch: test/issue-116-markdown-corpus
specs: [SPEC-118]
---

# Run: Issue #116 — extend the Markdown differential corpus

## Objective

The generated corpus of the scanner's differential test (SPEC-118 FR-118-41/43, ADR-0013) also
emits a leading BOM, U+00A0 / VT / FF at line ends, after list and quote markers, in delimiter
rows and after tags, lone-pipe lines as header and body rows, and link reference definitions
with single- and multi-line labels, all also inside block quotes and list items. The readings
are regenerated with cmark-gfm (cmarkgfm 2025.10.22). The comparison stays exact for everything
the scanner reports; only the deliberate under-reports are compared as "scanner ⊆ cmark-gfm".
Every new over-report is fixed red-first with scanner- and assertion-level regression tests.
Also: four review nits from PR #121.

## Plan

1. Extend `test/markdown-corpus.ts`; regenerate the fixture; run the differential test.
2. Classify differences: over-reports (false passes) are fixed red-first; deliberate
   under-reports get a narrow, tested subset rule.
3. PR #121 nits; SPEC-118 §20 and ADR-0013 for what changed; gate; PR; Codex rounds (max 4).

## Decisions

- **Subset rule, explicit and narrow** (`readingDifference` in `test/markdown-corpus.ts`): equality,
  or exactly the two documented fail-safe under-reports of ADR-0013: (a) in a document containing
  `]:` the scanner's headings and tables may stop early but must be a prefix of cmark-gfm's, in
  order; (b) a cmark-gfm table may be missing only when it has one column (a table without a pipe
  in its header or delimiter row, which the scanner reads but does not report, always has one).
  Every reported heading, table and row must equal cmark-gfm's at its position. Unit tests show
  it fails an extra heading, an extra row, an extra table, a changed cell, a reordered heading and
  an unreported one-column table, also in a document where a stop is allowed, and a heading
  missing from the middle.
- **The lazy `   |` header is no longer an under-report.** Fixing the row split made the scanner
  read it as cmark-gfm does (one empty cell), so it is reported and compared exactly; the subset
  rule needs no case for it.
- **Pipe-less tables became a generated case.** The extended underlines (`-\v`, `---\f`) create
  one-column tables without pipes, the third deliberate under-report of ADR-0013 point 2 (the
  issue named only two); they are covered by rule (b).
- **Comparable form:** link brackets, processing instructions and CDATA sections are stripped like
  the other inline markup (cmark-gfm renders `[foo]` with a definition as a link, and inline raw
  HTML may span lines). Emphasis markers stay: stripping `*` would hide a list marker misread as
  text.
- **10 000 recorded documents** instead of 5 000: the generator has more choices now; the test
  still runs in about 0.4 s. The fixture is kept Prettier-formatted, as on `main`, so its diff is
  line-based.
- **PR #121 Inventory-table nit:** no change needed. The row "Red first: pre-#56 padded table
  under load" has sat in the two-column Verification table since `4a9ff91`; every Inventory row
  has three cells.

## Work performed

1. Generator (`packages/benchmark-engine/test/markdown-corpus.ts`): `oddSpace()` (U+00A0, VT, FF)
   and `tail()` (odd whitespace at line ends of headings, setext lines, paragraphs, fences, table
   rows, delimiter rows, thematic breaks, link definitions); odd spaces after ATX hashes and
   closing sequences, after quote markers and as list-marker padding; tag lines followed by odd
   whitespace; lone-pipe header and body lines (`|`, ` |`, `   |`, `| `, `\f|` via tails);
   delimiter rows with `\f`, `\v`, U+00A0; a link-definition leaf (single- and multi-line labels,
   titles, multi-line titles, several definitions, `[]`, `[foo]` without a definition) followed by
   text, underlines, a table or a heading; one or two leading BOMs in 10 % of documents and a BOM
   inside a paragraph. All leaves nest in block quotes and list items as before.
2. Exploration (scratch tools: live comparison with cmarkgfm 2025.10.22 and a line-wise
   minimiser): 91 over-reports on the first run, all one class after minimising (below).
3. Fix in `src/markdown.ts`: `splitTableRow` follows cmark-gfm's `row_from_string`: no leading
   trim (the caller already skipped spaces and tabs; a lazy line keeps its indentation), only a
   pipe as the first character is a leading pipe, a lone pipe yields no cell (`[]`), a line of
   VT/FF is one empty cell; `delimiterRow` needs at least one cell; the lazy-header regex and both
   lone-pipe special cases are replaced by the cell count.
4. Regenerated `test/fixtures/cmark-gfm-corpus.json` (seed 110, 10 000 documents) with
   `scripts/cmark-gfm-corpus.mjs`; `markdown-reference.test.ts` compares through
   `readingDifference` and tests the rule.
5. Regression tests: `markdown.test.ts` ("reads line tabulation or form feed before a leading pipe
   as a first cell (issue #116)") and `document-assertions.test.ts` ("does not read a table or row
   after a form feed before its leading pipe (issue #116)"); four new linear-time shapes.
6. PR #121 nits: `apps/web/test/markdown.test.ts` comment (~32 for a quadratic parser);
   `linearTimeRatio` throws for a size that is not a multiple of `LINEAR_SIZE_STEP`; the clock is
   chosen by probing both `run` and `baseline`; self-tests in `packages/core/test/linear-time.test.ts`.
7. Docs: SPEC-118 §20, ADR-0013 (Decision 3, Consequences), lesson update.

## Verification

| Check | Result |
| --- | --- |
| Red first: new scanner and assertion tests on the previous `src/markdown.ts` | both fail (a table read in a `>\f` quote; Hours 24 read from the shifted Backend row) |
| Red first: recorded corpus on the previous `src/markdown.ts` | 100 of 10 000 documents fail `readingDifference` (over-reports) |
| Red first: `linearTimeRatio` self-tests on the previous helper | size 1 000 resolved instead of throwing; async-baseline ratio 0.78 (bound < 0.29) |
| Recorded corpus after the fix | 10 000 / 10 000 accepted: 8 888 equal, 816 stopped after a link definition (prefix), 296 missing only one-column pipe-less tables |
| Offline, fresh seeds 2026 / 7 / 99 / 31337, 20 000 documents each | 0 / 1 / 1 / 1 differences, all inline markup inside heading text (raw inline HTML spanning lines, `*\v*` emphasis); no block-structure difference |
| Linear-time shapes (31) and helper self-tests under `taskset -c 0,1` with two `yes` | pass |
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | pass, 7/7 tasks, 100 % coverage (benchmark-engine 408 tests) |
| `pnpm build && pnpm verify:pack` (asked for by Codex round 1) | pass |
| CI on `a9b5c23` (PR #127) | all 8 checks pass |

Not verified: Windows (no platform-specific code); inline Markdown rendering (never parsed).

## Problems and deviations

- The first exploration showed 543 "under-reports" that were mostly the deliberate link-definition
  stop and pipe-less tables, plus comparable-form noise (link brackets, inline processing
  instructions); the noise was removed from the comparable form rather than tolerated.
- The issue named two under-report classes; the generator now also produces the third documented
  one (pipe-less tables).

## Lessons recorded

- Updated [Test a hand-written parser against the reference implementation, not review by
  review](../lessons/2026-10-22-test-a-parser-against-the-reference-not-reviews.md): generate a
  review's whole input class; compare deliberate under-reports with a tested subset rule.

## Codex adversarial review (PR #127)

| Round | Verdict | Findings |
| --- | --- | --- |
| 1 | needs-attention | no material finding: 208 788 targeted delimiter, body-row and container cases matched cmark-gfm 2025.10.22; runtime growth linear. Blocked only because its read-only sandbox could not run `pnpm build` / `verify:pack`; both pass in the worktree. |
| 2 | approve | no material finding: 88 448 fresh comparisons (link definitions, BOMs, odd whitespace after markers, ATX, setext, tag lines, containers, lazy lines) matched the comparison rules; generator classes, subset rule, comparable form and helper changes checked. |

Stopped after round 2 on approve.

## Follow-ups

- Heading levels are not compared; link reference definitions are still not parsed (the fail-safe
  stop covers 816 of the 10 000 recorded documents).
- The one-column rule of `readingDifference` cannot tell a pipe-less table from a piped
  one-column table the scanner failed to report (an under-report, never a false pass); the
  cmark-gfm 2025.10.22 source positions of tables in paragraphs are unreliable, so the recorder
  cannot mark pipe-less tables.
