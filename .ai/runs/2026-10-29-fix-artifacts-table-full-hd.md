---
title: Fit the Artifacts table in a Full HD viewport (issue 122)
date: 2026-10-29
agent: Claude Code / claude-opus-5-5
trigger: user request ("#122 rób"), via om-auto-fix-issue 122
status: completed
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
- **`wrap-anywhere` on the name, category and repository cells.** At first left out (to keep
  names whole at narrower widths), then added after the browser QA agent showed that real names
  do not break: agents-md and similar artifacts are named `<dir>/<file>` (`packages/core/src/
  artifacts.ts`), and snake_case names and one-word repository names have no break point. A
  nested path pushed the table to 1651px in a 1344px container. The cost: a path breaks inside
  a segment when its column is narrow; the full name stays visible.

## Work performed

1. Reproduced: base build at 1920, container 1056px, `scrollWidth` 1134 (demo) and 1196 (e2e
   worst-case rows).
2. Measured options by editing the live row to worst-case values (description 20/15/12rem at
   72rem main; main 80/90rem and no cap): see Decisions.
3. `globals.css` token, `lib/utils.ts` tailwind-merge registration, `layout.tsx` variant,
   `artifacts/page.tsx` wrapper; `tokeny.md`, `design-system.md`, Storybook `spacing.mdx`
   (layout table row at 1664px) and `what-is-missing.mdx` (issue 122 done).
4. `apps/web/e2e/artifacts-full-hd.spec.ts`: seeds an instruction named by a nested path
   (`packages/…/AGENTS.md`) with a long description, four categories and two repositories with
   one-word names (one snake_case) next to the demo artifact's mock run; asserts at 1920x1080 in light and dark that the document and the table container do not
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
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` | pass (100% coverage); `pnpm test` again after the QA fix: pass |
| `pnpm build`, `pnpm verify:pack` | pass |
| `pnpm test:e2e` | 62 passed (again after the QA fix: 62 passed) |
| `pnpm test:storybook` | 224 passed |
| Built CLI + demo, widths 320 to 2560 on `/artifacts`, `/`, `/repositories`, `/results` | no document overflow at any width; `/artifacts` main 1440 from 1664px, others 1152; the table scrolls in its container below ~1500px with the demo row |

| Codex adversarial review (`codex exec -s read-only`, after the QA fix) | approve, no material findings |

Not verified: other browsers than Chromium; zoom levels other than 100%; a real screen reader. `pnpm test:storybook` and `verify:pack` ran before the QA fix (it changed only classes on three cells of the page, which has no story).

## Problems and deviations

- Browser QA agent (round 1, Playwright on the built app, 1 major, 1 minor, 2 nits):
  - **Major, confirmed and fixed:** path-like and snake_case names overflowed the table again
    (1385 to 1533px in a 1344px container, Status cut). The e2e seed used only kebab-case.
    Red first: the e2e with a nested-path name failed on the previous commit (1651 > 1344), then
    `wrap-anywhere` on the three cells made it pass.
  - Minor: at 1440 and 1366 the table scrolls 14 and 88px inside its container. That is outside
    the target (1920) and is the documented narrow-viewport behaviour.
  - Nits that were there before this change: the mock badge wraps to two lines; the focusable table
    container has no accessible name (the page passes no `aria-label` to `Table`). Follow-up.
  - Passed: 1920 in both themes and with the theme toggle; widths 320 to 2560 without document
    scroll; keyboard order and focus rings; filters and invalid URL values keep the wide layout;
    13 other pages keep 1152px; no console errors; muted text 6.01:1 (light), 6.23:1 (dark).

- A comment `(#122)` in `page.tsx` failed the hex-colour guard; rewritten as "issue 122"
  (recorded in the lesson).
- SPEC-116 was not changed: its density and responsive rules still hold; the Full HD criterion
  is specific to the artifact list and lives in SPEC-101 §11.

## Lessons recorded

- [A truncated table cell keeps its max width as a floor](../lessons/2026-10-29-table-cells-truncate-at-their-max-width.md)

## Follow-ups

- Give the Artifacts `Table` an `aria-label` so its focusable scroll container is a named region (SPEC-122 P13); it was unnamed before this change.
