---
id: SPEC-120
title: Three-layer design tokens
status: draft
created: 2026-10-27
updated: 2026-10-27
category: feature
related: [SPEC-119, SPEC-004, ADR-0001]
---

# SPEC-120 — Three-layer design tokens

## 1. Summary

The web UI gets a complete design-token system in three layers (raw palette and scales,
semantic tokens, component tokens), recorded in [`apps/web/tokeny.md`](../../apps/web/tokeny.md)
and implemented in `apps/web/app/globals.css`. It extends the shadcn preset of
[SPEC-119](implemented/2026-10-23-shadcn-design-system.md) and fixes the non-text contrast
failures that SPEC-119's text-only checks did not cover.

## 2. Motivation and problem statement

SPEC-119 left literal colours on every semantic token, no spacing or typography tokens and ad
hoc values in pages (`text-[11px]`, `text-[10px]`, `rounded-md`, `w-56`, `max-w-6xl`). A
contrast audit on 2026-10-27 found every text pair passing but UI elements failing WCAG 1.4.11:
form control borders 1.26:1 (light) and 1.57:1 (dark), focus indicators 1.54:1 to 2.59:1 and a
warning icon 2.97:1.

## 3. Goals

- Raw values exist only in `globals.css`; app code uses semantic or component tokens.
- Every semantic token records its provenance (preset, requirement or decision).
- Every colour pair the UI uses meets 4.5:1 (text) or 3:1 (UI elements) in both themes, or is
  a documented exception.

## 4. Non-goals

Renaming the shadcn semantic tokens, a token export for Figma or Style Dictionary, migrating
every existing `text-xs`/`text-sm`/`gap-*` utility to a token (see §19), and new components.

## 5. User stories

As a keyboard user, I can see which control has focus in both themes.
As a user with low vision, I can see where a text field or select begins and ends.
As a contributor, I find each token's value, origin and intended use in one table.

## 6. Functional requirements

1. FR-120-1: `globals.css` MUST define the raw palette as `--palette-*` custom properties; no
   other declaration may contain a literal colour.
2. FR-120-2: semantic tokens MUST keep the shadcn names and reference the palette, with the
   values in `tokeny.md`.
3. FR-120-3: Input and NativeSelect MUST draw their boundary with the new `border-control`
   token (neutral-500 in both themes).
4. FR-120-4: focus indicators MUST use a solid `ring` (light neutral-700, dark neutral-400),
   1px in buttons, inputs, selects, badges and navigation; the global outline uses solid `ring`.
5. FR-120-5: status fills (`success`, `warning`, `info`, `destructive`) MUST NOT colour text or
   icons; those use `*-foreground`. Dark `success-foreground` equals `success` (green-72).
6. FR-120-6: typography, spacing, radius and width tokens MUST exist as Tailwind theme values
   (`text-caption`, `text-ui`, `text-body`, `text-page-title`, `text-metric`; `*-page-inline`,
   `*-page-block`, `*-section`, `*-grid`, `*-stack`, `*-inline`, `*-inline-tight`; `h-control`,
   `-sm`, `-xs`; `w-sidebar`; `rounded-surface`; `max-w-content`) and `cn` MUST merge them as
   the classes they stand for.
7. FR-120-7: component tokens MUST cover the secondary button hover and the ScoreBar fills and
   track; ScoreBar exposes `data-slot="score-bar"` and `data-slot="score-bar-fill"`.
8. FR-120-8: app code MUST NOT use arbitrary font sizes, Tailwind palette colours, hex colours,
   translucent focus rings or rounded corners; a unit test enforces this.

## 7. Non-functional requirements

No visual change beyond the listed fixes, square corners and the 11px minimum text size. No new
dependencies; no runtime requests (ADR-0001).

## 8. Domain entities and contracts

None; styling only.

## 9. Data flow

Unchanged.

## 10. API and interface design

`cn` in `apps/web/lib/utils.ts` uses `extendTailwindMerge` with the token names. Component
props and variants are unchanged.

## 11. UI/UX considerations

See `tokeny.md`: token table, colour pairs with measured ratios and non-token decisions D1 to
D10. Accepted exceptions: ScoreBar track (aria-hidden, value printed), decorative separators
and button fills identified by their labels.

## 12. Security considerations

None.

## 13. Error handling

Invalid-field styling (`aria-invalid`) is unchanged.

## 14. Edge cases

Focus on the primary button in the dark theme (`border-ring` on the lime fill is 1.33:1; the
outer ring against the page is 6.91:1). Translucent dark `input` fills under control borders.
Mobile padding switches at the `md` breakpoint through `--page-inline`.

## 15. Testing strategy

Unit: `test/design-tokens.test.ts` (forbidden classes, palette-only literals, new token values)
and `test/utils.test.ts` (`cn` merging). Playwright: `e2e/ui-contrast.spec.ts` measures control
borders, focus rings and ScoreBar fills at 3:1 in both themes; the existing text-contrast and
design-system suites must still pass.

## 16. Acceptance criteria

- [x] AC-1: `globals.css` implements the three layers and the values in `tokeny.md`.
- [x] AC-2: control borders, focus indicators and ScoreBar fills reach 3:1 in both themes in the
      browser.
- [x] AC-3: text contrast, button checks and theme switching still pass in both themes.
- [x] AC-4: the static token-usage rules and `cn` merging are enforced by unit tests.
- [x] AC-5: the quality gate, build, `verify:pack` and the full E2E suite pass.

## 17. Dependencies

Existing Tailwind 4 and tailwind-merge 3.

## 18. Open questions

None.

## 19. Future extensions

Migrate existing `text-xs`/`text-sm` and `gap-*`/`space-y-*` utilities to `text-ui`/`text-body`
and the `space-*` tokens; add a token export for design tools if needed.

## 20. Implementation status

Implemented and verified on 2026-10-27 (Linux, Node 22, Chromium); details in the run log
[`2026-10-27-design-tokens`](../runs/2026-10-27-design-tokens.md). The spec stays `draft`
until the maintainer approves it; all acceptance criteria are verified, so it can then move to
`implemented/`.

- `globals.css` has the raw palette, semantic tokens pointing at it and the component tokens;
  a unit test confirms no literal colour outside `--palette-*`.
- Measured in Chromium (light / dark): control borders 4.74 / 3.78, focus rings 10.37 / 6.94,
  navigation focus 9.93 / 6.94, ScoreBar fills 3.44 and 3.07 / 3.26 and 4.62. Before the change
  the same test measured 1.26 / 1.58, 1.54 / 1.87 and 2.48 / 3.79.
- Text contrast, button and design-system suites pass unchanged; full E2E 52/52.
- Not migrated (§19): existing `text-xs`/`text-sm` and most `gap-*`/`space-y-*` utilities.
