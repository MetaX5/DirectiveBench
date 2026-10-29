---
title: Storybook pages for the SPEC-123 design-system components (FileView, SideBySideDiff, FileStatusBadges)
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: user request (approval vehicle for SPEC-123 assumption A14, issue #152)
status: completed
branch: feat/spec-123-design-system-components
specs: [SPEC-123, SPEC-122]
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

## Problems and deviations

- Contributing asks for a state matrix with frozen hover, focus and pressed states. These
  components are not controls: their only interactive state is keyboard focus on the scroll
  region, covered by the FileView Keyboard story's play function instead of a frozen matrix.
- The worktree sandbox refused some compound shell commands (downloads, `git show` piped into
  files); the mockups were read with plain `git show` into the scratchpad.

## Lessons recorded

- [A component that must stack in a narrow column needs a container query](../lessons/2026-10-29-narrow-story-wrappers-need-container-queries.md)

## Follow-ups

- After approval (or changes) of D1 to D19: update SPEC-123 §11 and A14 in PR #154 or its
  successor; this PR does not edit the spec.
- Phase 1: replace `OutputFile` with the repository type and the limit copy with the engine
  constants (D18).
- Phases 3 to 5: Playwright tests, `ui-contrast` coverage of the row tints, browser QA agent and
  Codex review on the real pages.
