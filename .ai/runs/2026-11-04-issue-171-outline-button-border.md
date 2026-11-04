---
title: Outline button border reaches 3:1 (issue #171)
date: 2026-11-04
agent: Claude Code / claude-opus-5-5
trigger: issue #171, design option A approved by the maintainer on 2026-11-04
status: in-progress
branch: fix/issue-171-outline-button-border
specs: [SPEC-120, SPEC-122]
---

# Run: Outline button border reaches 3:1 (issue #171)

## Objective

The `outline` Button border was 1.26:1 on white in light (1.48 to 1.63 in dark), below WCAG
1.4.11's 3:1. Acceptance (issue #171): a token change in the design system with the Storybook
pages updated, `ui-contrast.spec.ts` measuring the outline border in both themes, `pnpm
test:storybook` and `pnpm test:e2e` green, browser QA in both themes.

## Plan

Chain `om-auto-fix-issue 171`: `om-verify-in-repo` → `om-root-cause` → `om-fix` → `om-open-pr
--handoff om-auto-review-pr` → `om-auto-review-pr --autofix` → `om-auto-qa-pr`, plus the Codex
adversarial review (AGENTS.md §2 step 14).

## Decisions

- Option A, approved by the maintainer on 2026-11-04 (not re-opened): the outline variant
  swaps `border-border` and `dark:border-input` for the existing `border-control`
  (neutral-500, both themes), as fields do (tokeny.md D3). Fills, focus outline, outline Badge,
  cards, separators and `--border` are unchanged; no new tokens.
- This reverses the accepted exception U12 for the outline button only; U12 now covers
  separators and card outlines. New pair U14 records the button border.
- Known, accepted: in dark the border against the button's own translucent fill is below 3:1 on
  a solid `muted` surface (2.78 rest / 2.55 hover) and on a hovered card table row on hover
  (2.82); against the surrounding surface it is at least 3.19:1, which identifies the boundary.
- The config `baseBranch` is `auto`; it resolves to the default branch `main`.

## Work performed

1. Red first: extended the D3 unit test in `apps/web/test/design-tokens.test.ts` (outline
   variant uses `border-control`, never `border-border`/`border-input`) and the outline border
   measurements in `apps/web/e2e/ui-contrast.spec.ts` (Filter on `/artifacts`, verdict buttons
   on the blind review; rest, hover, focus; against the surface and the button's own fill).
2. Fix in `apps/web/components/ui/button.tsx`.
3. Docs: `tokeny.md` (token rows, U12, U14, exceptions, D3), `design-system.md`, Storybook
   `contrast.tsx` (U14.1 to U14.3), `colour.mdx`, `shape.mdx`, `parameters.mdx`, `button.mdx`
   §7, a Variants play assertion in `button.stories.tsx`, SPEC-120 FR-120-3, D10 and status.

## Verification

| Check | Result |
| --- | --- |
| Red: `vitest run test/design-tokens.test.ts` before the fix | 1 failed: `expected [ 'border-border', … ] to include 'border-control'` |
| Red: `playwright test e2e/ui-contrast.spec.ts` on a build without the fix | 4 failed: outline border 1.26 light, 1.58 dark (Filter on a card); verdict 1.26 / 1.58 |
| Green: the same spec with the fix | 6 passed |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test` | pass, web 478/478, 100% coverage |
| `pnpm build && pnpm verify:pack` | pass |
| `pnpm test:e2e` | 109 passed |
| `pnpm test:storybook` | 68 files, 304 tests passed (both themes, axe) |

Measured in Chromium (e2e, Filter on a card and verdict buttons on a card):

| State | Light vs surface | Light vs own fill | Dark vs surface | Dark vs own fill |
| --- | --- | --- | --- | --- |
| Rest | 4.74 | 4.74 | 3.78 | 3.40 |
| Hover | 4.74 | 4.35 | 3.78 | 3.11 |
| Focus border | 4.74 | | 3.78 | |
| Focus outline (unchanged) | 10.37 | | 6.94 | |

Computed from the token values (Storybook Colour page measures the same within 0.25): light
4.74 page and card, 4.35 muted, 4.54 sidebar; dark 4.18 page, 3.78 card, 3.19 muted.

## Problems and deviations

- `// #171` in `.tsx` comments failed the D2 hex-colour rule; rewritten as "Issue 171" (lesson
  below).

## Lessons recorded

- [2026-11-04-issue-numbers-trip-the-hex-colour-rule](../lessons/2026-11-04-issue-numbers-trip-the-hex-colour-rule.md)

## Follow-ups

To be completed after review and QA.
