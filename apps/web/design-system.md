# DirectiveBench design system: summary for agents

Read this before building or changing a screen in `apps/web`. The full manual is the Storybook
(`pnpm --filter @directivebench/web storybook`, sources in `apps/web/stories/` and
`apps/web/components/**/*.stories.tsx`). Tokens: [`tokeny.md`](tokeny.md). Spec:
[SPEC-122](../../.ai/specs/2026-10-28-design-system-storybook.md).

## Character

A dense, quiet, local tool for people who write AI agent skills. Its main job is benchmarking:
RED (without the skill) against GREEN (with it). It is honest: mock results and planned
features are always labelled. Flat and square (shadcn preset Lyra `b3Rq8QfWi`), neutral
surfaces with one lime accent, Figtree, 32px controls with 12px text, light and dark themes.

## Components

| Component | Import | When | When not |
|---|---|---|---|
| Button | `@/components/ui/button` | An action on this page; one `default` per section | Navigation (use a link) |
| Badge | `@/components/ui/badge` | A status or property in one to three words | Anything clickable or a sentence |
| Card | `@/components/ui/card` | One page section; `CardTitle` is the h2 | Inside another card |
| Input | `@/components/ui/input` | Single-line text, inside a visible `<label>` | Choosing from a list |
| Textarea | `@/components/ui/textarea` | Text over several lines, inside a visible `<label>` | A single-line value |
| NativeSelect | `@/components/ui/native-select` | One value from a short list, "All" first in filters | Search in many options |
| Table | `@/components/ui/table` | Rows with the same columns; give it an `aria-label` | Facts of one item (`dl`) |
| Pre | `@/components/ui/primitives` | JSON, code, raw output | A path in a sentence (`font-mono`) |
| PageHeader | `@/components/common` | The h1 of every page, once | Section titles |
| EmptyState | `@/components/common` | Nothing to show; "nothing yet" and "no results" differ | Errors |
| NotInitialized | `@/components/common` | No local database | An empty list |
| PlannedSection | `@/components/common` | A whole page that is not built | One planned part of a page (muted Badge) |
| StatusBadge | `@/components/common` | A run's outcome, from `runDisplayStatus` | A job's state |
| JobStatusBadge | `@/components/common` | A job's queue state | A run's outcome |
| MockBadge | `@/components/common` | Every mock-agent result, always | Real agents |
| NotSandboxedBadge | `@/components/common` | A `local-process` suite | Sandboxed runs |
| Markdown | `@/components/artifacts/markdown` | Rendering artifact Markdown safely | App-authored text |

Raw `<button>`, `<input>` (except hidden), `<select>`, `<textarea>` and `<table>` in `app/`
or `components/` fail ESLint. Missing primitives (Dialog, Checkbox, Combobox, Toast,
Tabs, Pagination, Tooltip, DescriptionList) are listed in Storybook under "What is missing":
do not improvise one; ask.

## Semantic tokens

- Text: `text-foreground` (default), `text-muted-foreground` (supporting), `text-primary-text`
  (links), `text-destructive-foreground`, `text-success-foreground`,
  `text-warning-foreground`, `text-info-foreground`.
- Fills: `bg-background`, `bg-card`, `bg-muted`, `bg-primary` (main action), status fills
  `bg-success/10`, `bg-warning/10`, `bg-info/10`, `bg-destructive/10`.
- Borders: `border` (separators), `border-control` (fields), focus `border-ring` with
  `ring-1 ring-ring`; buttons a 2px `outline-ring` offset 2px.
- Type: `text-page-title`, `text-metric` (with `tabular-nums`), `text-body`, `text-ui`,
  `text-caption` (minimum 11px). Never `text-xs` or `text-sm`.
- Spacing by relation: `gap-inline` (controls in a row), `gap-inline-tight` (icon and label,
  badges), `space-y-stack` (inside a panel), `gap-grid` (between panels), `space-y-section`
  and `mb-section` (between sections), `px-page-inline py-page-block` (page).
- Sizes: `h-control` (32px), `h-control-sm`, `h-control-xs`, `max-w-content`, `max-w-wide` (only through `data-layout="wide"` on a
  wide table page; `main` switches itself), `w-sidebar`.
- Shape: square; `rounded-surface` only. No shadows.

## If… use…

| If you need | Use |
|---|---|
| To do something here | `Button` |
| To go elsewhere | A link; `<Button asChild><Link>` only for a page's next step |
| An irreversible or warning-overriding action | `Button` `destructive`, inline confirmation (Risky-action pattern) |
| A run outcome | `StatusBadge`, plus `MockBadge` for mock runs |
| Progress or a result message | A `role="status"` line in words; no spinner, no toast |
| A field error | Under the field: `aria-invalid`, `aria-describedby`, `role="alert"` |
| A list the user edits (tags, assigned suites) | Item + `outline` `sm` "Remove" named for it, add field under the list, one status line, focus back to the field (Form, "Lists edited in place") |
| A reversible removal that keeps history | No confirmation; say what was kept |
| Loading | Disable the control and say what is happening |
| Numbers | `formatScore` ("83.3%"), `formatDelta` ("+50 pts"), `formatDuration`, `formatDate` from `lib/utils.ts` |

## What to avoid

- A mock result without `MockBadge`; a feature that pretends to work; an en or em dash in app
  text (U+2013, U+2014); rewriting imported content or agent output.
- Hex, Tailwind palette classes, arbitrary values (`p-[13px]`), `text-xs`, `text-sm`,
  rounded corners, gradients, glows, blur, emoji or sparkles as icons.
- A `div` with `onClick`, a placeholder as the only label, status shown only by colour, a
  disabled button without its reason, information only in a `title` tooltip, a card inside a
  card, everything centred.
- A new component, variant or token without the maintainer's approval (Storybook,
  "Contributing").

## Commands

```bash
pnpm lint && pnpm typecheck && pnpm test   # includes the token guard
pnpm test:storybook                        # every story in both themes, with axe
pnpm --filter @directivebench/web storybook
```
