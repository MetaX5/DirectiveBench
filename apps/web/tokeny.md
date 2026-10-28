# Design tokens

Approved by the maintainer on 2026-10-27. This file records the token system for `apps/web`;
[`app/globals.css`](app/globals.css) implements it
([SPEC-120](../../.ai/specs/implemented/2026-10-27-design-tokens.md)).

How the tokens appear in code:

| Token in this file | CSS custom property | Tailwind utility |
|---|---|---|
| `palette-*` | `--palette-*` | none (raw layer) |
| colour tokens (`primary`, `muted-foreground`, …) | `--primary`, `--muted-foreground`, … | `bg-primary`, `text-muted-foreground`, … |
| `border-control` | `--border-control` | `border-control` |
| `text-caption`, `text-ui`, `text-body`, `text-page-title`, `text-metric` | `--text-*` in `@theme` | same names |
| `space-page-inline`, `space-page-block`, `space-section`, `space-grid`, `space-stack`, `space-inline`, `space-inline-tight` | `--spacing-page-inline` (from `--page-inline`), `--spacing-page-block`, … | `px-page-inline`, `py-page-block`, `mb-section`, `gap-grid`, `space-y-stack`, `gap-inline`, `gap-inline-tight` |
| `radius-surface` | `--radius-surface` | `rounded-surface` |
| `size-content-max` | `--container-content` | `max-w-content` |
| `control-height`, `-sm`, `-xs` | `--spacing-control`, `-sm`, `-xs` | `h-control`, `size-control`, … |
| `sidebar-width` | `--spacing-sidebar` | `w-sidebar` |
| `button-secondary-hover` | `--button-secondary-hover` | `hover:bg-button-secondary-hover` |
| `scorebar-*` | `--scorebar-red-phase`, `--scorebar-green-phase`, `--scorebar-track` | `bg-scorebar-*` |

A new `--text-*`, `--spacing-*`, `--radius-*` or `--container-*` token must also be added to
`extendTailwindMerge` in [`lib/utils.ts`](lib/utils.ts), or `cn()` drops or fails to merge it.

Layers:

- **raw**: palette and scales, referenced only in `app/globals.css`;
- **semantic**: named by purpose; the existing shadcn names are kept (decision D1);
- **component**: only where a component needs its own value.

Provenance codes:

- **P1**: shadcn preset `b3Rq8QfWi` ([SPEC-119](../../.ai/specs/implemented/2026-10-23-shadcn-design-system.md) AC-1).
- **FR-n**: SPEC-119 functional requirement n.
- **A§7**: [AGENTS.md](../../AGENTS.md) §7 (contrast rule).
- **D-n**: decisions listed under the table.

Values are given as light / dark. **Bold** names are new tokens or changed values.

## Tokens

| Token | CSS property | Layer | Value (light / dark) | Provenance | Use for | Do not use for |
|---|---|---|---|---|---|---|
| `palette-white` | `--palette-white` | raw | oklch(1 0 0) | P1 | `app/globals.css` only | anything outside `app/globals.css` (applies to the whole raw layer) |
| `palette-neutral-{50,100,200,400,500,550,700,800,900,950}` | `--palette-neutral-{50,100,200,400,500,550,700,800,900,950}` | raw | L = .985 / .97 / .922 / .708 / .556 / .5 / .371 / .269 / .205 / .145, C = 0 | P1; 550 from FR-8 (contrast override); 700 from D4 | `app/globals.css` | components and pages |
| `palette-zinc-{100,800,900}` | `--palette-zinc-{100,800,900}` | raw | (.967 .001 286.375) / (.274 .006 286.033) / (.21 .006 285.885) | P1 | `app/globals.css` | components and pages |
| `palette-lime-{50,300,400,500,600,700,800,900,950}` | `--palette-lime-{50,300,400,500,600,700,800,900,950}` | raw | Tailwind lime scale, L .986 to .274 | P1 | `app/globals.css` | components and pages |
| `palette-red-{300,400,600,800}` | `--palette-red-{300,400,600,800}` | raw | Tailwind red scale | P1, FR-6 | `app/globals.css` | components and pages |
| `palette-green-{45,55,72}` | `--palette-green-{45,55,72}` | raw | (.45 .12 150) / (.55 .14 150) / (.72 .15 150) | FR-4, FR-8, D6 | `app/globals.css` | components and pages |
| `palette-amber-{45,68,80}` | `--palette-amber-{45,68,80}` | raw | (.45 .10 70) / (.68 .15 70) / (.80 .14 75) | FR-4, FR-8 | `app/globals.css` | components and pages |
| `palette-blue-{45,55,72}` | `--palette-blue-{45,55,72}` | raw | (.45 .12 250) / (.55 .13 250) / (.72 .12 250) | FR-4, FR-8 | `app/globals.css` | components and pages |
| `scale-spacing` | none | raw | 0.25rem × n (Tailwind `--spacing`) | Tailwind 4 | source for `space-*` | new code where a `space-*` token fits |
| `scale-radius` | `--radius`, `--radius-{sm,md,lg,xl,2xl,3xl,4xl}` | raw | `--radius` .625rem and its sm to 4xl steps | P1 | the shadcn generator only | components (see D7) |
| `scale-text` | none | raw | .6875 / .75 / .875 / 1 / 1.125 / 1.25 / 1.5 rem | Tailwind, D8 | source for `text-*` | arbitrary `text-[Npx]` |
| `background` (page surface) | `--background` | semantic | white / neutral-950 | P1 | `body` and `main` background | cards, sidebar |
| `foreground` (default text) | `--foreground` | semantic | neutral-950 / neutral-50 | P1 | text on background, card, muted | text on primary or status fills |
| `card`, `card-foreground` | `--card`, `--card-foreground` | semantic | white / neutral-900; text = foreground | P1 | Card, base of Pre | page background |
| `popover`, `popover-foreground` | `--popover`, `--popover-foreground` | semantic | same as card | P1 | reserved for shadcn menus | currently unused; not a card substitute |
| `primary` (primary action) | `--primary` | semantic | lime-400 / lime-500 | P1 | primary button fill, default badge, text selection | text colour (1.54:1 on white) |
| `primary-foreground` | `--primary-foreground` | semantic | zinc-900 / zinc-900 | P1, FR-6 | text on `primary` | other backgrounds |
| `primary-text` (link) | `--primary-text` | semantic | lime-900 / lime-400 | FR-6 (override) | links, link button and badge | fills |
| `secondary`, `secondary-foreground` | `--secondary`, `--secondary-foreground` | semantic | zinc-100 / zinc-800; zinc-900 / neutral-50 | P1 | secondary button and badge | layout surfaces |
| `muted` (subtle surface) | `--muted` | semantic | neutral-100 / neutral-800 | P1 | muted badge, ghost hover, selected row, ScoreBar track, Pre (/40) | text, borders |
| `muted-foreground` (muted text) | `--muted-foreground` | semantic | neutral-550 / neutral-400 | P1, FR-8 | descriptions, placeholders, nav labels, supporting icons | text on solid status fills; disabled fields |
| `accent`, `accent-foreground` | `--accent`, `--accent-foreground` | semantic | neutral-100 / neutral-800; neutral-900 / neutral-50 | P1 | hover inside shadcn components | own surfaces (use `muted`) |
| `destructive` (error fill) | `--destructive` | semantic | red-600 / red-400 | P1 | background /10 to /30, invalid field border, red ScoreBar bar | text |
| `destructive-foreground` (error text) | `--destructive-foreground` | semantic | red-800 / red-300 | FR-6, FR-8 | error messages, text on destructive /10 to /30 | text on solid `destructive` |
| `success` | `--success` | semantic | green-55 / green-72 | FR-4 | background /10, border /30, green ScoreBar bar | text, icons |
| `success-foreground` | `--success-foreground` | semantic | green-45 / **green-72** | FR-8, D6 | success text and icons | fills |
| `warning` | `--warning` | semantic | amber-68 / amber-80 | FR-4 | background /10, border /40 | text and icons (2.97:1 in light) |
| `warning-foreground` | `--warning-foreground` | semantic | amber-45 / amber-80 | FR-8, D5 | warning text and icons | fills |
| `info`, `info-foreground` | `--info`, `--info-foreground` | semantic | blue-55 / blue-72; blue-45 / blue-72 | FR-4, FR-8 | as the success pair | as the success pair |
| `border` (subtle outline) | `--border` | semantic | neutral-200 / white 10% | P1 | separators, card outline, table rows | form control borders |
| `input` (control fill) | `--input` | semantic | neutral-200 / white 15% | P1 | light: disabled field fill (/50); dark: control fill (/30, hover /50) | borders (D3) |
| **`border-control`** | `--border-control` | semantic | neutral-500 / neutral-500 | D3, A§7, WCAG 1.4.11 | input, select and future checkbox borders | separators, cards |
| `ring` (focus indicator) | `--ring` | semantic | **neutral-700 / neutral-400** (was 400 / 500) | D4 | `border-ring` plus solid `ring-1` on focus | decoration |
| `sidebar`, `sidebar-foreground` | `--sidebar`, `--sidebar-foreground` | semantic | neutral-50 / neutral-900; neutral-950 / neutral-50 | P1 | side panel, app name | page content |
| `sidebar-accent`, `sidebar-accent-foreground` | `--sidebar-accent`, `--sidebar-accent-foreground` | semantic | neutral-100 / neutral-800; neutral-900 / neutral-50 | P1 | active and hovered nav item | outside navigation |
| `sidebar-ring` | `--sidebar-ring` | semantic | **neutral-700 / neutral-400** | D4 | focus in navigation | outside the sidebar |
| `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-border` | `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-border` | semantic | lime-600 / lime-500; lime-50 / lime-950; as `border` | P1 | reserved for the generator | currently unused |
| `chart-1` to `chart-5` | `--chart-{1,2,3,4,5}` | semantic | lime-300 / 500 / 600 / 700 / 800 (both themes) | P1 | series in future charts | statuses; currently unused |
| `font-sans` (body font) | `--font-sans` | semantic | Figtree Variable, system fallbacks | P1, SPEC-119 §7, ADR-0001 | the whole UI | |
| `font-heading` (heading font) | `--font-heading` | semantic | same as `font-sans` | P1 | Card title (shadcn generator) | a second typeface |
| `font-mono` (code font) | `--font-mono` | semantic | ui-monospace stack | P1 | code, paths, identifiers | prose |
| **`text-page-title`** | `--text-page-title` | semantic | 1.25rem / 600 | D8 (PageHeader) | page h1 | cards |
| **`text-metric`** | `--text-metric` | semantic | 1.5rem / 600, tabular numerals | D8 | numeric stat tiles | headings |
| **`text-body`** | `--text-body` | semantic | .875rem | D8 | page descriptions, navigation, messages | controls |
| **`text-ui`** | `--text-ui` | semantic | .75rem | P1 (Lyra, dense) | controls, cards, tables, badges | titles |
| **`text-caption`** | `--text-caption` | semantic | .6875rem (11px) | D8, D10 | nav section labels, hints, "planned" tag | errors, main content |
| **`space-page-inline`** | `--spacing-page-inline` | semantic | 1rem, 2rem from `md` | D9 (`app/layout.tsx`) | horizontal padding of `main` | card interiors |
| **`space-page-block`** | `--spacing-page-block` | semantic | 1.5rem | D9 | vertical padding of `main` | |
| **`space-section`** | `--spacing-section` | semantic | 1.5rem | D9 | gap between page header and sections | card interiors |
| **`space-grid`** | `--spacing-grid` | semantic | 1rem | D9 | card grids (`gap-4`) | lists inside a card |
| **`space-stack`** | `--spacing-stack` | semantic | 0.5rem | D9 | vertical stack inside a card | gaps between sections |
| **`space-inline`**, **`space-inline-tight`** | `--spacing-inline`, `--spacing-inline-tight` | semantic | 0.5rem; 0.25rem | D9 | a row of controls; icon next to a label | page layout |
| **`radius-surface`** | `--radius-surface` | semantic | 0 | P1 (Lyra), D7 | all surfaces and controls | |
| **`size-content-max`** | `--container-content` | semantic | 72rem | `app/layout.tsx` | maximum width of `main` | |
| `card-spacing` | none (inline in `components/ui/card.tsx`) | component | 1rem, .75rem for size `sm` | P1 (already in `components/ui/card.tsx`) | Card | other components |
| **`control-height`**, **`control-height-sm`**, **`control-height-xs`** | `--spacing-control`, `--spacing-control-sm`, `--spacing-control-xs` | component | 2rem / 1.75rem / 1.5rem | FR-6 (32px) | Button, Input, NativeSelect | |
| **`button-secondary-hover`** | `--button-secondary-hover` | component | color-mix(in oklch, secondary, foreground 5%) | FR-6 (currently an inline class) | secondary button hover | |
| **`sidebar-width`** | `--spacing-sidebar` | component | 14rem | `app/layout.tsx` | aside | |
| **`scorebar-red-phase`**, **`scorebar-green-phase`**, **`scorebar-track`** | `--scorebar-red-phase`, `--scorebar-green-phase`, `--scorebar-track` | component | destructive 70%; success 80%; muted | RED/GREEN evaluation spec, D5 | ScoreBar on result pages | statuses outside ScoreBar |

## Colour pairs and contrast

Thresholds: text 4.5:1, UI elements 3:1. ✗ marks a ratio below the threshold; `before → after`
shows values changed by this proposal. Ratios follow the WCAG 2.x formula, with translucent
colours composited over the real surface in both themes, computed from the token values.
[`e2e/ui-contrast.spec.ts`](e2e/ui-contrast.spec.ts) measures U01–U05 and U09–U10 in Chromium
(within 0.05 of these values) and `e2e/text-contrast.spec.ts` measures the text pairs on real
pages.

| ID | Pair (text or element / background) | Use | Light | Dark |
|---|---|---|---|---|
| T01 | foreground / background | page text | 19.79 | 18.96 |
| T02 | card-foreground / card | card text | 19.79 | 17.16 |
| T03 | muted-foreground / background | PageHeader description | 6.00 | 7.63 |
| T04 | muted-foreground / card | CardDescription, tables | 6.00 | 6.91 |
| T05 | muted-foreground / muted | muted badge | 5.50 | 5.83 |
| T06 | muted-foreground / sidebar | inactive nav, sidebar footer | 5.75 | 6.91 |
| T07 | sidebar-accent-foreground / sidebar-accent | active nav item | 16.42 | 14.48 |
| T08 | muted-foreground / sidebar-accent | "planned" on active item | 5.50 | 5.83 |
| T09 | primary-foreground / primary | default button and badge | 11.55 | 9.07 |
| T10–T11 | primary-foreground / primary 80% (on card, on page) | primary button hover | 12.43 | 6.19 / 6.00 |
| T12–T13 | secondary-foreground / secondary (rest, hover) | secondary | 16.11 / 14.25 | 14.26 / 12.64 |
| T14–T15 | foreground / outline background (rest, hover) | outline | 19.79 / 18.15 | 15.33 / 14.03 |
| T16–T17 | foreground and muted-foreground / ghost hover | ghost | 18.15 / 5.50 | 15.86 / 6.39 |
| T18–T19 | primary-text / background, card | links | 8.72 | 12.89 / 11.67 |
| T20–T21 | destructive-foreground / background, card | errors | 8.37 | 10.30 / 9.33 |
| T22–T23 | destructive-foreground / destructive /10 to /30 | destructive button and badge | 7.01 / 5.82 | 6.97 / 5.77 |
| T24 | success-foreground / success /10 | success badge | 6.19 | 6.52 → 6.54 |
| T25–T26 | warning-foreground / warning /10, card | badge, blockers | 6.89 / 7.61 | 7.83 / 9.41 |
| T27 | info-foreground / info /10 | info badge | 6.53 | 6.22 |
| T28 | success-foreground / background | success text | 7.04 | 8.44 → 8.47 |
| T29–T31 | foreground / muted 40%, 50%, 100% | Pre, row hover, selected row | 19.12 / 18.96 / 18.15 | 16.13 / 15.86 / 14.48 |
| T32–T33 | foreground and muted-foreground / field background | field value, placeholder | 19.79 / 6.00 | 15.33 / 6.17 |
| T34 | primary-foreground / primary | text selection in select | 11.55 | 9.07 |
| U01–U02 | field border / card, page | input, select | 1.26 ✗ → 4.73 | 1.57 ✗ / 1.47 ✗ → 3.79 / 4.18 |
| U03 | `ring` / card | focus border | 2.59 ✗ → 10.39 | 3.79 → 6.91 |
| U04 | `ring/50` → solid `ring` | focus halo | 1.54 ✗ → 10.39 | 1.87 ✗ → 6.91 |
| U05 | sidebar-ring / sidebar (and on active item) | nav focus | 2.48 ✗ → 9.95 / 9.53 | 3.79 → 6.91 / 5.83 |
| U06 | destructive / card | invalid field border | 4.76 | 6.19 |
| U07 | warning icon: warning → warning-foreground | DatabaseZap | 2.97 ✗ → 7.61 | 9.41 |
| U08 | muted-foreground / card | supporting icons, select chevron | 6.00 | 6.91 |
| U09–U10 | success 80% and destructive 70% bar / track | ScoreBar | 3.06 / 3.42 | 4.66 / 3.24 |
| U11 | muted / card | ScoreBar track | 1.09 ✗ | 1.19 ✗ |
| U12 | border / background | separators, card outline, outline button | 1.26 ✗ | 1.25 ✗ |
| U13 | primary / background | primary button fill | 1.54 ✗ | 10.12 |

After the changes all 50 pairs were recomputed: none fell below its threshold and no ratio
decreased. Accepted exceptions:

- **U11**: ScoreBar is `aria-hidden` and its value is printed as text, so WCAG 1.4.11 does not
  apply. Optional fix: outline the track with `border-control` (at least 3.79:1).
- **U12**: decorative; the outline button is identified by its label (15.33:1). No change.
- **U13**: the button is identified by its label (9.07:1). No change.
- Focus on the primary button: `border-ring` against the dark-theme button fill is 1.33:1; the
  outer `ring-1` against the page is 6.91:1, so the indicator stays visible.

## Decisions that are not tokens

1. **D1**: the semantic layer keeps the shadcn names so the generator keeps working
   ([lesson](../../.ai/lessons/2026-10-23-shadcn-generators-need-a-compatibility-review.md)).
   Purpose names are documented in the table, not duplicated as CSS variables.
2. **D2**: `palette-*` and `scale-*` appear only in `app/globals.css`. `app/` and `components/`
   use no raw Tailwind colours (e.g. `zinc-500`), `#hex` values or arbitrary `text-[Npx]`.
3. **D3**: form controls use `border-control` for their border; `input` is a fill only.
4. **D4**: the focus indicator is `border-ring` plus a solid `ring-1`, without `/50`. Badge
   moves from `ring-[3px]` to 1px.
5. **D5**: status colours (`success`, `warning`, `info`, `destructive`) are used only as fills
   (/10 to /30), borders (/30 to /40) and ScoreBar bars. Text and icons always use
   `*-foreground`.
6. **D6**: dark-theme `success-foreground` merges with `success` into one colour (green-72)
   instead of two nearly identical values.
7. **D7**: corners are square, as in the Lyra preset. App code uses `rounded-surface`; the
   generated `components/ui` files keep their equivalent `rounded-none`.
8. **D8 and D10**: the type scale has the five steps in the table. The minimum text size is
   11px, so the "planned" tag grows from 10px.
9. **D9**: spacing values come from their frequency in the current code (`gap-4` ×11,
   `space-y-2`, `mb-6`, `py-6`, `px-4 md:px-8`).
10. Contrast thresholds: text 4.5:1, large text 3:1, UI elements 3:1. Check both themes on the
    real composited surface. Disabled elements are exempt (FR-8, A§7).
11. Every enabled button has a pointer cursor. An inline form button matches the field height,
    32px (FR-6).
12. Selects stay native; options use the system Canvas and CanvasText colours (FR-3).
13. Badges wrap and clip nothing at a 390px viewport (FR-7).
14. Fonts are bundled locally with no remote requests (SPEC-119 §7, ADR-0001).
15. Dark mode uses the `.dark` class and next-themes; the toggle persists the choice (FR-5).
16. The mock agent and planned features are always visibly labelled. UI copy uses no en or em
    dashes (A§7).
17. Reserved tokens (`popover`, `sidebar-primary`, `chart-*`) stay for the shadcn generator and
    are not used without a separate decision.
