---
title: Storybook pages for the SPEC-123 design-system components (FileView, SideBySideDiff, FileStatusBadges)
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: user request (approval vehicle for SPEC-123 assumption A14, issue #152)
status: completed
branch: feat/spec-123-design-system-components
specs: [SPEC-123, SPEC-122, ADR-0014]
---

# Run: Storybook pages for the SPEC-123 design-system components

## Objective

SPEC-123 (draft, PR #154) proposes three new design-system pieces in assumption A14, which needs
the maintainer's approval before Phase 3 starts: `FileView`, `SideBySideDiff` and the
file-status badge mapping. Build them with stories and docs pages per Storybook "Contributing",
with the pure logic (bounded line diff, badge mapping, notices) in `apps/web/lib` at 100% unit
coverage, and list every UI decision the spec and the design system do not settle, so the
maintainer can approve them before any page, data access or blind-review code exists. Same
approach as PR #141 (Textarea and D1 to D14 approved first).

Out of scope: pages, repository functions, server actions, the blind-review flow, the spec file
and PR #154.

## Plan

1. Read SPEC-123 (§6.2, §6.3, §11, §14, A12, A14) from `origin/spec/agent-run-output-files`,
   the PR #154 mockups, `apps/web/design-system.md`, the Contributing page and how Textarea was
   added (commit cca820f).
2. Pure logic in `apps/web/lib`: `line-diff.ts` (Myers, bounded by
   `FILE_DIFF_MAX_EDIT_LINES = 1000`, summary sentence) and `output-files.ts` (interim
   `OutputFile` type, badge mapping, notices, sizes, display lines), with unit tests.
3. Components in `apps/web/components/output-files/`, stories for every state, three docs pages
   with the 13 sections, catalogue rows and mentions in Start here, How to choose, What is
   missing and `design-system.md`.
4. Gate, screenshots of the stories in both themes, run log with the decisions, draft PR.

No re-plan was needed.

## Decisions (D1 to D19, for the maintainer to approve)

None of these is approved. Each is what the stories show today; each can change before Phase 3.

- **D1 Components.** Three product components in `components/output-files/` (Storybook
  `Product/Benchmarking/…`): `FileView`, `SideBySideDiff`, `FileStatusBadges`. The shared
  line-numbered block `CodeLines` is internal, not a design-system component. No new primitive,
  Badge variant or token.
- **D2 Badge mapping.** The change is a property, so `outline` for Added, Modified and Deleted
  (not `success` for Added: green means a passed run here). Truncated `warning`; not kept
  `muted` with the reason ("Binary, not kept", "Artifact file", "Not kept"); "N redacted"
  `info`; "Only left" / "Only A" `outline`, first. A deleted file gets no second badge.
- **D3 FileView header.** Path as an `h3` in `font-mono` (wraps anywhere) and the size in
  muted text ("2.1 KB", binary units, one decimal). No badges in the view (the list carries
  them). Notices are plain `role="status"` sentences in the default text colour, not the
  mockup's yellow box (Alert is a missing primitive).
- **D4 Copy beyond FR-123-21.** "The file is empty.", "N secrets redacted." / "1 secret
  redacted.", "Shown with LF line endings." (§11), "Not present in this agent run." (§14),
  "No line comparison: one side has no text to compare.", "N lines removed, M lines added."
  (one part dropped when zero), neutral "N lines only in A, M lines only in B.".
- **D5 Line numbers.** A sticky, right-aligned gutter on `bg-muted`, `aria-hidden` and
  `select-none`: screen readers read the text only and a copy takes no numbers.
- **D6 Long lines and height.** Lines never wrap; they scroll horizontally inside the block
  (spec §14). No maximum height: a long file grows the page (unlike `Pre`'s 28rem), so the
  horizontal scrollbar sits at the end of a long file; arrow keys scroll the focused block.
  Alternative: cap the height (both scrollbars close, but the two diff columns then scroll
  vertically on their own and lose alignment).
- **D7 Volume.** Every kept line is rendered (up to about 30,000 lines for a 1 MB file), with
  no virtualisation or render cap. Not measured in a page yet.
- **D8 Scroll region.** `role="region"` with a name ("Content of src/render.php", in a diff
  "Left: src/render.php"), one tab stop, the solid focus ring of `Pre`.
- **D9 Diff granularity.** Whole lines only, no word highlighting inside a line. Within a run
  of changes, removed and added lines are paired row by row; the longer side continues against
  filler rows (`bg-muted`, no number) so both columns keep the same rows.
- **D10 Bound.** The bound counts removed plus added lines after trimming the common start and
  end: 1,000 is still aligned, 1,001 is not. Above it, both files are shown as they are with the
  spec's sentence. Measured: two 30,000-line files (1.4 MB) with 1,000 changed lines diff in
  25 ms; over the bound the diff gives up in 10 ms.
- **D11 Change colours and non-colour cue.** Removed lines `bg-destructive/10` with a visible
  `-` in `text-destructive-foreground`; added lines `bg-success/10` with `+` in
  `text-success-foreground`. Each changed line starts with an `sr-only` "Removed:" or "Added:";
  the glyph is `aria-hidden` (FR-123-32).
- **D12 Blind review is neutral.** `variant="neutral"`: no red or green (colour must not hint
  that a side is worse), `bg-info/10` on both sides, markers `<` and `>` (classic `diff`), and
  `sr-only` "Only in A:" / "Only in B:".
- **D13 Labels.** Each side has a short `name` ("Left", "Right", "A", "B") and an optional
  `description` ("Baseline (v2), repetition 1"); the column heading is "Left: Baseline (v2),
  repetition 1" or just "A". Blind review passes no description. Headings: path `h3`, columns
  `h4`.
- **D14 Responsiveness.** A container query (`@3xl`, 48rem of the component's own width) puts
  the columns side by side; narrower, they stack, left first, also inside a narrow page column.
- **D15 Missing or unreadable side.** When either side has no text (not present, binary, not
  kept, deleted), no diff is computed: the summary says so, that side shows its notice and the
  other side is shown without markers.
- **D16 Identical files.** Both columns stay, without markers, under "The files are
  identical." (not collapsed to one view).
- **D17 Keyboard.** One tab stop per scroll region; no shortcuts (next change, toggle wrap) and
  no synchronised scrolling between the columns. Vertical alignment comes from equal rows and the
  page scroll.
- **D18 Interim types and copy.** `OutputFile` lives in `lib/output-files.ts` and mirrors the
  proposed `agent_run_files` columns; Phase 1's repository type replaces it. "1 MB" and
  "10 MB" are written in the copy until `OUTPUT_FILE_MAX_BYTES` / `OUTPUT_RUN_MAX_BYTES` exist.
- **D19 Documentation status.** Catalogue, Start here, How to choose, What is missing and
  `design-system.md` list the three as "proposed (SPEC-123)"; "diff view" leaves the
  missing-primitives table. If a decision is rejected, these entries change with it.

## D20 Syntax highlighting (approved by the maintainer on 2026-10-29)

D1 to D19 were approved on PR #155. D20 adds server-side syntax highlighting, specified in
SPEC-123 §6.7 (FR-123-70 to 77), NFR-123-07, AC-12 to AC-15 and ADR-0014 on
`origin/spec/agent-run-output-files`. Implemented here as the component and library half of
Phase 3a; no page renders highlighted files yet.

- `apps/web/lib/syntax-highlight.ts` (`server-only`): the constants, `SYNTAX_LANGUAGE_BY_EXTENSION`,
  `languageForPath`, `highlightLines` and the `HighlightResult`, `HighlightedLine` and
  `SyntaxTokenKind` types with the spec's names. Shiki's `createHighlighterCore` with the 13
  grammars (their embedded grammars load as dependencies), the JavaScript regex engine and
  `createCssVariablesTheme({ variablePrefix: '--syntax-' })`; a memoised promise that is
  forgotten when creation fails; `codeToTokens` on the whole text split like `displayLines`;
  neighbouring tokens of one kind merged; colours other than `var(--syntax-token-*)` become
  `null`. Errors log the language and error name only.
- Tokens: `--syntax-foreground` and nine `--syntax-token-*` in `:root` and `.dark`, on six new
  palette entries (violet, teal and orange at 48/47 and 75) and existing ones; Tailwind colours
  `text-syntax-*`; `tokeny.md` rows and contrast pairs S01 to S10 (each on the code surface and
  the D11 and D12 tints), measured by the Foundations/Colour story in both themes.
- Rendering: `CodeLine.tokens`; `LineText` renders one `span` per token, React text only.
  `FileView` takes `highlight?`; each `SideBySideDiff` side takes `highlight?`, attached to rows
  by line number after the plain-line diff. Notes from `syntaxHighlightNotice`
  (`lib/output-files.ts`) join the side's `role="status"` notices.
- Stories: precomputed tokens in `components/output-files/highlight-fixtures.json`, kept equal
  to the highlighter output by `test/highlight-fixtures.test.ts`
  (`UPDATE_HIGHLIGHT_FIXTURES=1` rewrites it).

Contrast of the syntax colours (WCAG 2.x, `card` + `muted` 40% = code surface, then the
`destructive`, `success` or `info` 10% row tint; computed from the OKLCH values, matched by the
Chromium measurement within 0.25):

| Token | Light: code / removed / added / neutral | Dark: code / removed / added / neutral |
|---|---|---|
| syntax-foreground | 19.13 / 16.04 / 16.83 / 16.88 | 16.15 / 14.13 / 13.69 / 13.72 |
| comment | 5.81 / 4.87 / 5.11 / 5.12 | 6.52 / 5.71 / 5.53 / 5.54 |
| keyword | 6.89 / 5.78 / 6.06 / 6.08 | 7.26 / 6.35 / 6.15 / 6.16 |
| string | 6.24 / 5.23 / 5.49 / 5.50 | 7.89 / 6.90 / 6.69 / 6.70 |
| string-expression | 6.78 / 5.69 / 5.97 / 5.98 | 7.20 / 6.30 / 6.10 / 6.11 |
| constant | 7.22 / 6.06 / 6.35 / 6.37 | 6.86 / 6.00 / 5.82 / 5.83 |
| function | 6.70 / 5.62 / 5.90 / 5.91 | 7.27 / 6.36 / 6.16 / 6.18 |
| parameter | 7.38 / 6.18 / 6.49 / 6.51 | 8.83 / 7.73 / 7.48 / 7.50 |
| punctuation | 10.02 / 8.40 / 8.82 / 8.84 | 13.38 / 11.71 / 11.34 / 11.37 |
| link | 8.47 / 7.10 / 7.45 / 7.47 | 10.99 / 9.62 / 9.31 / 9.34 |

Lowest: comment on a removed row in light, 4.87:1.

## Work performed

1. `apps/web/lib/line-diff.ts` and `test/line-diff.test.ts`: Myers after prefix and suffix
   trimming, interned lines, early refusal when the line counts alone pass the bound, row
   pairing, `diffSummary`. The tests compare the edit count with a textbook LCS on 300
   generated pairs and check both files survive whole.
2. `apps/web/lib/output-files.ts` and `test/output-files.test.ts`: `fileBadges`,
   `onlyInBadge`, `fileNotices`, `formatBytes`, `formatSize`, `displayLines`.
3. `components/output-files/`: `code-lines.tsx`, `file-view.tsx` (with `FileNotices`),
   `side-by-side-diff.tsx`, `file-status-badges.tsx`, `fixtures.ts` and three story files
   (FileView 12 stories, SideBySideDiff 11, FileStatusBadges 3).
4. Docs pages `stories/product/file-view.mdx`, `side-by-side-diff.mdx`,
   `file-status-badges.mdx` (13 sections each, marked as proposed); catalogue rows (the catalogue
   story now expects 22 links); Start here, How to choose, What is missing, `design-system.md`.
5. Lesson on container queries (below).
6. D20 (see above): `lib/syntax-highlight.ts`, `test/syntax-highlight.test.ts`,
   `test/syntax-highlight-failure.test.ts`, `test/highlight-fixtures.test.ts`,
   `syntaxHighlightNotice`, the tokens, the component props, 11 new stories (FileView 8,
   SideBySideDiff 3) and the FileView, SideBySideDiff and Colour docs pages and
   `design-system.md`. Dependencies `@shikijs/core`, `@shikijs/engine-javascript` and
   `@shikijs/langs` 4.5.0 in `apps/web` only.

## Verification

| Command / check | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm typecheck` | pass (7 tasks) |
| `pnpm test` | pass; web 15 files, 311 tests, 100% coverage (the two new lib files 100% lines, branches, functions, statements) |
| `pnpm test:storybook` | pass; 68 files, 276 tests (both themes, axe `error`) |
| `storybook build` | pass (the three MDX pages compile) |
| Screenshots | SideBySideDiff Playground light and dark at 1280px, BlindReview light, NarrowScreen at 360px, FileView Playground dark, NotKept, FileStatusBadges AllStatuses: reviewed by eye |

D20 gate (after the D20 commit):

| Command / check | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass; web 18 files, 391 tests, 100% coverage (`lib/syntax-highlight.ts` 100% lines, branches, functions, statements) |
| `pnpm test:storybook` | pass; 68 files, 298 tests. A first run inside the full gate timed out two stories at 15 s (one unrelated, Foundations/Icons) under load; the rerun passed |
| `pnpm build` | pass (from a clean `apps/web/.next` and `apps/cli/dist`) |
| `pnpm verify:pack` | pass; runtime dependencies stay `next`, `react`, `react-dom` |
| 256 KiB TypeScript timing (NFR-123-07) | 357 ms (target under 1 s) |
| Packaging proof with a temporary page (not committed) | a throwaway Server Component page highlighting a PHP file, built and packed: Shiki code in `.next/server` chunks only, no `@shikijs` require left external, nothing in `.next/static`; the installed tarball (no `@shikijs` in its `node_modules`) served the page with `text-syntax-token-*` spans and `&lt;script&gt;` as text |
| Screenshots | FileView HighlightedTsx light, SideBySideDiff Highlighted dark: reviewed by eye |

Red first: the NarrowScreen story failed with the first `md:grid-cols-2` layout (columns did not
stack) and passes with the container query.

Not verified:

- No page uses the components, so no Playwright test, no `ui-contrast` measurement and no
  browser QA agent or Codex review (AGENTS.md §2.14 applies to the Phase 3 to 5 pages).
- Contrast is checked by axe in the stories only (text on the `*/10` row tints and the
  `bg-muted` gutter); the Colour page does not list the row tints as pairs.
- Rendering cost of a 30,000-line file in a page (D7).
- No screen-reader check of the `sr-only` markers.
- The docs pages were checked to compile, not read through in the Storybook UI.
- D20: no page renders highlighted files, so `verify:pack` cannot check a highlighted file
  (FR-123-77's smoke test) and `e2e/ui-contrast.spec.ts` does not measure the syntax colours on
  a page (AC-14); both are Phase 3a's page work. The packaging was proved once by hand with a
  temporary page (above). The diff row attachment is checked by Storybook play functions, not
  by a unit test (components are outside unit coverage).

CI fix after the D20 push (run 40943388665, "Unit tests (100% coverage)"):

- **Failure 1, fixtures differ on CI.** Root cause, reproduced: Shiki's cooperative
  `tokenizeTimeLimit` (500 ms, checked with `Date.now()` by vscode-textmate) also counts the
  lazy compilation of a grammar's regular expressions. On the slow runner the first PHP line
  ran out of time, so the rest of it became one `<?php` token instead of `<?` (keyword) and
  `php`. Locally the same output appears with `tokenizeTimeLimit: 1` on a fresh highlighter
  (first pass `<?php`, second pass `<?` + `php`) and with a `Date.now` stub advancing 1 s per
  read. Fix: `highlightLines` takes `{ lineTimeLimitMs }` (default
  `SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS`; `SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT = 0` turns it
  off); the fixtures and every exact-token test use the no-limit option. The committed JSON
  already equalled the no-limit output. Regression test
  `test/highlight-fixtures.test.ts > do not depend on the speed of the machine`: under the slow
  clock the shipped limit changes the output, and the no-limit computation still equals the
  fixtures. A mocked test checks that the default passes 500 ms and 10,001 to Shiki.
- **Product code:** no behaviour change. The limit stays on in production: FR-123-75 makes it
  cooperative only, a cut line is still complete text (only fewer colours), and the
  enforceable bound is FR-123-78's worker deadline in Phase 3a. Warming the grammars would not
  make output deterministic either (rules compile on first use, on any line) and would add
  start-up work.
- **Failure 2, timeout (13.8 s on CI).** The exact 262,144-byte test tokenized 256 KiB of code,
  and its last line was a 6,000-character identifier (the slow-regex case, 0.7 s locally). It
  now uses one short line of code plus one line over `SYNTAX_HIGHLIGHT_MAX_LINE_CHARS`, which
  Shiki skips: same byte bound, 19 ms. The 256 KiB wall-clock test (30 s bound) was replaced by
  `expectLinearTime` (CPU-time growth from 1.4 KiB to 45 KiB against a linear baseline, the
  repository's helper). The fixture tests got a named 60 s timeout (4.8 s under load).
- Reproduced CI capacity with `taskset -c 0,1 pnpm test --force` and two `yes` processes: web
  394 tests pass, 100% coverage.

## Problems and deviations

- Contributing asks for a state matrix with frozen hover, focus and pressed states. These
  components are not controls: their only interactive state is keyboard focus on the scroll
  region, covered by the FileView Keyboard story's play function instead of a frozen matrix.
- The worktree sandbox refused some compound shell commands (downloads, `git show` piped into
  files); the mockups were read with plain `git show` into the scratchpad.

- D20 deviations, for the maintainer:
  - The dependency is `@shikijs/core`, `@shikijs/engine-javascript` and `@shikijs/langs`
    (4.5.0, exact like `remark-gfm`), not `shiki`: with pnpm only direct dependencies can be
    imported, and FR-123-77 asks for the `@shikijs/*` entry points. ADR-0014 says
    "`apps/web/package.json` gains `shiki`".
  - `highlightLines(text, language)` takes `SyntaxLanguage | null`, so the `no-language`
    result exists for callers that pass `languageForPath(path)` straight through.
  - The server log of FR-123-74 is a `console.error` with an ESLint `no-console` exception
    (the web app has no logger; SPEC-014 §6 keeps console output to the CLI). It logs the
    language and the error name, never the message or content.
  - `tokenizeMaxLineLength` is passed as `SYNTAX_HIGHLIGHT_MAX_LINE_CHARS + 1`: Shiki leaves a
    line of exactly the limit plain, and FR-123-75 says lines *longer than* 10,000 stay plain.
  - Shiki's CSS-variables theme uses `string-expression` for quoted strings, tags and JSON
    keys' values, and `string` only for inline code and a few others; the palette gives
    `string-expression` the green and `string` the teal.
- D20 finding (needs a decision): `tokenizeTimeLimit` does not interrupt one slow regex
  match. A TypeScript or JavaScript line of one 9,000-character identifier takes about 1.6 s
  (three lines 4.8 s), so a 256 KiB file of such lines could take tens of seconds, beyond the
  intent of NFR-123-07 and FR-123-74. Options: a total time budget per file (line-by-line with
  `grammarState`), or a lower line limit. Not changed here, because both alter SPEC-123.

## Lessons recorded

- [A component that must stack in a narrow column needs a container query](../lessons/2026-10-29-narrow-story-wrappers-need-container-queries.md)
- [Shiki's per-line time limit does not bound one slow regex match, and its line-length limit is exclusive](../lessons/2026-10-29-shiki-time-limit-does-not-bound-one-regex-match.md)

## Follow-ups

- After approval (or changes) of D1 to D19: update SPEC-123 §11 and A14 in PR #154 or its
  successor; this PR does not edit the spec.
- Phase 1: replace `OutputFile` with the repository type and the limit copy with the engine
  constants (D18).
- Phases 3 to 5: Playwright tests, `ui-contrast` coverage of the row tints, browser QA agent and
  Codex review on the real pages.
- D20, Phase 3a page: call `highlightLines` in the Server Components, extend `verify:pack` to
  render a highlighted file from the tarball, measure the `--syntax-*` colours in
  `e2e/ui-contrast.spec.ts`, and check that the browser loads no Shiki chunk.
- D20: decide how to bound the slow-regex case (finding above) before a page highlights
  untrusted files.
