---
title: Three-layer design tokens with contrast fixes
date: 2026-10-27
agent: Claude Code / claude-opus-5-5
trigger: maintainer request to build a complete design system with tokens, then "lećmy dalej"
status: completed
branch: feat/design-tokens
specs: [SPEC-120, SPEC-119]
---

# Run: Three-layer design tokens with contrast fixes

## Objective

Turn the approved token proposal (`apps/web/tokeny.md`: three layers, provenance, contrast of
every used colour pair in both themes) into code. Acceptance criteria: SPEC-120 AC-1 to AC-5.

## Plan

1. Proposal and contrast audit (computed from `globals.css` and the classes used in `app/` and
   `components/`), approved by the maintainer, saved as `apps/web/tokeny.md`.
2. Red tests: static token-usage rules, `cn` merging, browser non-text contrast.
3. Implement the layers in `globals.css`, switch components and pages to tokens.
4. Quality gate, real-app screenshots, spec, lesson, run log, PR.

## Decisions

- D1 to D10 as listed in `tokeny.md`, approved by the maintainer on 2026-10-27.
- D7 (square corners) was applied to all 11 `rounded`/`rounded-md` uses in app code, not only
  the ScoreBar and markdown ones named in the proposal, because the rule says all surfaces.
- The outline button keeps `dark:border-input`: its border is decorative (U12 exception), so the
  `border-input` ban is limited to Input and NativeSelect.
- Existing `text-xs`/`text-sm`/`gap-*` utilities were not migrated wholesale (focused change);
  the new tokens are used where the proposal named a value (layout, PageHeader, stats, nav,
  card grids). Recorded as SPEC-120 §19.

## Work performed

- `apps/web/tokeny.md`: token table, colour pairs, decisions; implementation mapping added.
- `apps/web/app/globals.css`: `--palette-*`, semantic tokens referencing it, `border-control`,
  `ring`/`sidebar-ring` neutral-700 / neutral-400, dark `success-foreground` green-72, type,
  spacing, radius, container and component tokens; solid global `outline-ring`.
- Components: Input/NativeSelect `border-control`, solid 1px focus rings (Button, Input,
  NativeSelect, Badge), `h-control*` sizes, secondary hover token, ScoreBar tokens and
  `data-slot`s, warning icon `text-warning-foreground`, `text-caption` for 10/11px text,
  `text-page-title`, `text-metric`, layout tokens, `rounded-surface`.
- `apps/web/lib/utils.ts`: `extendTailwindMerge` with the new token names.
- Tests: `test/design-tokens.test.ts`, `test/utils.test.ts` cases, `e2e/ui-contrast.spec.ts`.
- SPEC-120, specs index, lesson and lesson update.

## Verification

| Check | Result |
| --- | --- |
| Red: `e2e/ui-contrast.spec.ts` before the change | 2/2 fail: light input border 1.26, focus 1.54 / 2.58, nav focus 2.48; dark border 1.58, focus 1.87 |
| Red: `test/design-tokens.test.ts` before the change | 7 fail (arbitrary sizes, `text-warning` icon, `/50` rings, `border-input`, 11 rounded, literal colours, missing tokens) |
| Red: `cn` token cases | 2 fail (`text-caption` dropped next to `text-muted-foreground`) |
| Green: `e2e/ui-contrast.spec.ts` | 2/2 pass; light 4.74 / 10.37 / 9.93, ScoreBar 3.44 / 3.07; dark 3.78 / 6.94 / 6.94, ScoreBar 3.26 / 4.62 |
| `pnpm lint`, `pnpm typecheck` | pass (7/7 tasks) |
| `pnpm test` | 1,787 passed, 2 skipped, 100% coverage in all 7 packages |
| `pnpm build`, `pnpm verify:pack` | pass |
| `pnpm test:e2e` | 52/52 pass, including text contrast and design-system suites |
| Real app (built CLI, demo data) | Screenshots of /repositories with keyboard focus and a result page, both themes: visible field borders and focus, square corners, ScoreBar unchanged in colour |

Not verified: browsers other than Chromium, Windows and macOS, forced-colours mode, and the
pages not covered by the demo data beyond the existing text-contrast scan.

## Review round 1 (om-auto-review-pr)

- Finding: the destructive Button variant overrode the solid focus ring with
  `ring-destructive/20` and `border-destructive/40`; measured red-first in
  `e2e/ui-contrast.spec.ts` at 1.42:1 ring / 2.05:1 border (light) and 1.94:1 / 1.94:1 (dark).
  Fixed by dropping the variant's focus overrides (Button and Badge) so the base solid `ring`
  applies; the e2e spec now focuses "Register anyway" on the home-directory confirmation and
  measures 9.33:1 (light) and 5.79:1 (dark).
- The unit rule now forbids any translucent `focus-visible:ring-*`/`border-*` colour (it failed
  on the old Button) and every non-`none`/`surface` `rounded*` form, and a `cn merge config`
  test checks every `@theme` text, spacing, radius and container token against `cn` (it failed
  with a token removed from `lib/utils.ts`).
- The ScoreBar check now fails if no bar with a visible fill was measured.

## Problems and deviations

- tailwind-merge dropped `text-caption` next to a text colour (lesson recorded).
- `pkill -f` on the screenshot server ended the shell with code 144 (known, see the 2026-10-14
  testing lesson); the server was stopped.

## Lessons recorded

- [Register custom Tailwind theme tokens with tailwind-merge](../lessons/2026-10-27-tailwind-merge-needs-custom-tokens.md)
- Updated [Verify preset button contrast](../lessons/2026-10-23-verify-preset-button-accessibility.md)
  with the non-text contrast follow-up.

## Follow-ups

- Migrate remaining `text-xs`/`text-sm` and spacing utilities to the tokens (SPEC-120 §19).
- Maintainer approval of SPEC-120, then move it to `implemented/`.
