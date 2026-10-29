---
title: Fit the Artifacts table in a Full HD viewport (issue 122)
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: user request ("#122 rób"), via om-auto-fix-issue 122
status: in-progress
branch: fix/issue-122-artifacts-table-full-hd
specs: [SPEC-101, SPEC-116, SPEC-122]
---

# Run: Fit the Artifacts table in a Full HD viewport (issue 122)

## Objective

Issue #122 (F01): at 1920x1080, 100% zoom, with the sidebar, the Artifacts table must show every
column, Status included, without horizontal scrolling of the document or the table. Worst-case
rows (long name, long description, several categories, long repository names, a mock run) must
fit, with readable badges and honest mock wording in both themes. Narrower viewports keep
accessible overflow. Playwright covers the geometry.

## Plan

1. Reproduce with the built CLI and the demo data, and measure.
2. Compare the two mechanisms the issue allows (narrower description, wider main) by numbers.
3. Implement the smallest change that meets the target, red-first e2e, docs and spec.
4. Full gate, e2e, Storybook, browser QA agent, Codex review, PR.

## Decisions

- **Wider main for the Artifacts page only, through a new token `--container-wide: 90rem`
  (`max-w-wide`).** Approved by the maintainer in chat on 2026-10-29 (design-system.md requires
  approval for a new token). Measured at 1920 with worst-case rows: the table needed 1164px in a
  1056px container. The ten other columns were at their floor (one-line headers, ~814px), so the
  description had to shrink to 12rem to fit, with 0px spare and the badges squeezed; rejected.
  Raising 72rem for all pages was rejected because text, form and detail pages read better narrow.
- **Opt-in mechanism:** the page wraps its content in `<div data-layout="wide">`, and `main` in
  `app/layout.tsx` carries `has-data-[layout=wide]:max-w-wide`. Server-only, no route logic in
  the layout, and no other page matches.
- **No `wrap-anywhere` on name, category or repository cells.** It would let the browser break
  kebab-case names mid-word at narrower widths instead of scrolling the table. Real names break
  at hyphens; a single unbroken word wider than the spare space still makes the table scroll in
  its focusable container (documented in SPEC-101 §11).

## Work performed

1. Reproduced: base build at 1920, container 1056px, `scrollWidth` 1134 (demo) and 1196 (e2e
   worst-case rows).
2. Measured options by editing the live row to worst-case values (description 20/15/12rem at
   72rem main; main 80/90rem and no cap): see Decisions.
3. `globals.css` token, `lib/utils.ts` tailwind-merge registration, `layout.tsx` variant,
   `artifacts/page.tsx` wrapper; `tokeny.md`, `design-system.md`, Storybook `spacing.mdx`
   (layout table row at 1664px) and `what-is-missing.mdx` (issue 122 done).
4. `apps/web/e2e/artifacts-full-hd.spec.ts`: seeds an artifact with a long name and
   description, four categories and two long-named repositories next to the demo artifact's mock
   run; asserts at 1920x1080 in light and dark that the document and the table container do not
   scroll, that every header ends inside the container and Status is in view; and that `/`,
   `/repositories` and `/results` keep 1152px while `/artifacts` gets 1440px. Screenshots
   are kept as test output.
5. SPEC-101 §11 "List width (issue #122)" and a checked acceptance criterion.
6. Lesson `2026-10-29-table-cells-truncate-at-their-max-width.md`.

## Verification

| Command / check | Result |
| --- | --- |
| Red first: new e2e against the base build | 3 failed (container 1196 > 1056; main 1152 instead of 1440) |
| Red first: `design-tokens.test.ts` after adding the token only | 2 failed (token undocumented, `max-w-wide` not merged), then pass |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` | pass (100% coverage) |
| `pnpm build`, `pnpm verify:pack` | pass |
| `pnpm test:e2e` | 62 passed |
| `pnpm test:storybook` | 224 passed |
| Built CLI + demo, widths 320 to 2560 on `/artifacts`, `/`, `/repositories`, `/results` | no document overflow at any width; `/artifacts` main 1440 from 1664px, others 1152; the table scrolls in its container below ~1500px with the demo row |

Not verified: other browsers than Chromium; zoom levels other than 100%.

## Problems and deviations

- A comment `(#122)` in `page.tsx` failed the hex-colour guard; rewritten as "issue 122"
  (recorded in the lesson).
- SPEC-116 was not changed: its density and responsive rules still hold; the Full HD criterion
  is specific to the artifact list and lives in SPEC-101 §11.

## Lessons recorded

- [A truncated table cell keeps its max width as a floor](../lessons/2026-10-29-table-cells-truncate-at-their-max-width.md)

## Follow-ups

- None yet.
