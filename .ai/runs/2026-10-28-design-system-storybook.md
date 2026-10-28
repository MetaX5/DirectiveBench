---
title: Design-system documentation in Storybook (SPEC-122, #134)
date: 2026-10-28
agent: Claude Code / claude-opus-5-5
trigger: maintainer request ("zaczynaj 134"), issue #134, prompt .ai/specs/briefs/2026-10-27-design-system-storybook.md
status: complete
branch: feat/design-system-storybook
specs: [SPEC-122, SPEC-119, SPEC-120, SPEC-121]
---

# Run: design-system documentation in Storybook

## State

- **Completed stages:** 0 (inventory and plan), 1 (foundations), 2 (primitives), 3 (product components and patterns), 4 (pages that teach), 5 (verification and report).
- **Approved by the maintainer:** the stage 0 plan, Q1–Q5 and P1–P5 (2026-10-28; Q4: fix the
  two em dashes here; Q5: the Storybook CI job becomes required). #132 was merged first, as
  the prompt requires.
- **Approved in stage 1 review:** P6 to P10 (2026-10-28).
- **Approved in stage 2 review:** P11 to P13 (2026-10-28).
- **Approved in stage 4 review:** the AGENTS.md diff (applied in stage 5).
- **Approved in stage 5 review:** P14 (implemented), push and PR; the maintainer asked me to
  make the "Storybook (browser, both themes)" check required (Q5).
- **Open questions:** none.
- **Next step:** the maintainer reviews the PR and runs the agent test below.

## Objective

Build the design-system documentation in Storybook following the prompt in stages 0 to 5,
stopping after each stage for the maintainer's "dalej". The acceptance criteria are in
SPEC-122 §16.

## Plan

See SPEC-122, Implementation Plan.

## Decisions

- SPEC-122 §18 records the maintainer's answers to Q1–Q5 and the accepted proposals P1–P5.

## Work performed

Stage 0:
- Read the prompt, AGENTS.md, the lessons, the product brief, SPEC-119, SPEC-120,
  SPEC-121 and `tokeny.md`.
- Inventoried the routes, the components, the product components locked in page files and the
  planned screens (`backlog.md`, SPEC-109, SPEC-113, SPEC-115, SPEC-116, SPEC-118, the
  category spec).
- Researched the Storybook version and add-ons for Next 16.4, React 19.3, Tailwind 4.3 and
  Vitest 5. Both research tasks ran as subagents.
- Wrote the draft SPEC-122 and this run log.

Inventory facts used by the plan:
- Every page is a server component that reads the database. No component outside `app/`
  reads data itself.
- `components/ui` has no `next/*` or `server-only` imports.
- `nav.tsx` uses `usePathname`, and `auto-refresh.tsx` uses `useRouter`.
- Two app-authored strings still contain an em dash (`components/common.tsx:73`, `:137`).

Stage 1:
- Installed the nine planned dev dependencies, exact versions, in `apps/web`; `package.json`
  has nothing else new. `pnpm peers check` reports one unmet peer: `tsconfck` 3.1.6 (from the
  Storybook Vite builder) wants TypeScript ^5, the repo uses 6.0.3. Typecheck and builds pass.
- `.storybook/`: `main.ts` (framework, add-ons, remark-gfm, telemetry and onboarding off),
  `preview.tsx` (globals.css, Figtree, theme global and decorator, themed docs container,
  a11y as errors), `theme.ts` (`.dark` on `<html>`, also for MDX pages through the globals
  events), `manager.ts` (brand and tab title), `preview.css` (MDX list markers).
- `vitest.storybook.config.ts` with the light and dark projects; scripts; CI job
  "Storybook (browser, both themes)".
- Blocks in `stories/blocks/`: `tokeny.ts` reads `tokeny.md`, `token-table.tsx` previews the
  tokens, `contrast.tsx` measures every contrast pair, `a11y.ts` holds the one documented
  exception.
- Seven Foundations MDX pages and five story files (11 stories).
- Guards: `design-system-scope.json` adds `stories`, `.storybook` and `.mdx`; MDX pages are
  checked on their `className` values; a new test bans en and em dashes in Storybook files.
- Q4: `MockBadge` and `PlannedSection` now read "Mock agent: not an AI evaluation" and
  "Planned: not implemented"; the E2E constants follow. Specs still quote the old wording,
  which is documentation and stays with #123, as does the CLI demo line.

Stage 2:
- Implemented the accepted P2, P6 and P9 (plus the Q2 rule for every colour transition) in
  `components/ui/*`, `components/nav.tsx` and `components/artifacts/content-tab.tsx`, with two
  guard tests. Removed the stage 1 `heading-order` exception.
- `.storybook/states.css` re-declares the `hover`, `focus-visible` and `active` variants so
  `data-preview-state` freezes a state; it imports `globals.css`, so the app CSS is unchanged.
- `stories/blocks/state-matrix.tsx`; colocated stories for the seven primitives
  (`components/ui/*.stories.tsx`, 37 stories); "Parameters in force" and seven 13-section
  MDX pages in `stories/primitives/`.
- axe found `scrollable-region-focusable` on a long `Pre` and on a table at 320px: documented
  exception and proposal P13.

Stage 3:
- P13 in `components/ui/primitives.tsx` (Pre) and `components/ui/table.tsx`.
- Product stories colocated in `components/` (11 files) and pages in `stories/product/`.
- Pattern stories and pages in `stories/patterns/`; each pattern is a composition of real
  components in its story file.
- `Nav` stubs `usePathname` through `@storybook/nextjs-vite/navigation.mock`: per-story
  `appDirectory` fails like the global one (lesson updated). `ThemeToggle` runs under a
  next-themes provider seeded from the toolbar theme, and its play function toggles `<html>`.
- `ContentTab` could not render: `lib/artifacts.ts` pulls `@directivebench/core`, whose index
  imports Node modules. Moved to "What is missing" (stage 4).
- Gaps between the patterns and the app, for "What is missing" in stage 4:
  - no result count and no per-filter removal on `/artifacts` (only "Clear filters");
  - focus does not move to the first invalid field after a submit;
  - the disabled Run button is not linked to its blockers with `aria-describedby`;
  - the `/artifacts` "Clear filters" link uses `h-8` and `leading-8`, outside the tokens;
  - ScoreBar, VariantCard and AssertionDetails stay locked in the results page.
- While iterating, Vite re-optimised newly found dependencies and reloaded the test run, which
  failed some stories once; a rerun and a cold-cache run pass. CI starts cold.

Stage 4:
- Eight MDX pages in `stories/design-system/`, a catalogue block
  (`stories/blocks/catalogue.tsx`) with a story, and `apps/web/design-system.md`.
- Found while writing Content: the app shows scores as percentages and changes in points
  (`formatScore`, `formatDelta` in `lib/utils.ts`). The stories of stages 2 and 3 used
  decimals; they now use the formatters.
- A docs page whose MDX file name differs from its CSF file gets the file name as its id
  (`status-badges.mdx` became `--status-badges`, breaking the catalogue link); renamed to
  `status-badge.mdx`.
- Proposed AGENTS.md change, not applied (prompt stage 4):

```diff
@@ §2 Before you finish
-    `pnpm lint && pnpm typecheck && pnpm test` — plus `pnpm build && pnpm verify:pack` when you
-    touched `apps/cli`, `apps/web`, packaging or dependencies, and `pnpm test:e2e` for UI changes.
+    `pnpm lint && pnpm typecheck && pnpm test` — plus `pnpm build && pnpm verify:pack` when you
+    touched `apps/cli`, `apps/web`, packaging or dependencies, and `pnpm test:e2e` and
+    `pnpm test:storybook` for UI changes.
@@ §6 Commands
 pnpm test:e2e         # Playwright smoke test (builds required)
+pnpm test:storybook   # every Storybook story in both themes, with axe (Chromium required)
@@ §7 Conventions
+- Before building or changing UI in `apps/web`, read
+  [`apps/web/design-system.md`](apps/web/design-system.md) and the Storybook
+  (`pnpm --filter @directivebench/web storybook`). Use its components, tokens and patterns;
+  a new component or variant follows its "Contributing" page and gets stories and a page.
```

## Verification

Stage 0 produced documents only. Stage 1, all on 2026-10-28:

| Command | Result |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | pass; web 265 tests, 100% coverage unchanged |
| `pnpm test:storybook` | 10 files, 22 tests pass (11 stories × 2 themes), on a cold cache too |
| `pnpm --filter @directivebench/web build-storybook` | pass |
| `pnpm build && pnpm verify:pack` | pass; the tarball has no Storybook file (checked with `tar tzf`) |
| `pnpm test:e2e` | 52 passed |

- Contrast: all 45 pairs with a threshold pass in both themes (48 rows, U11 to U13 are
  accepted exceptions).
  Dark translucent surfaces (T14 to T17, T29, T30, T32, T33) measure 0.06 to 0.20 above
  `tokeny.md`. T22 and T23 first measured wrong because I put the wrong fill under them
  (/10 and /30 in both themes); the button uses /10 and /20 in light, /20 and /30 in dark.
- Red first: an MDX `className` with `text-sm p-[13px] bg-zinc-900` and an em dash, and a
  story with `text-xs` and a radius class, failed five token tests; a raw `<button>` in a
  story failed ESLint. The same run caught a variable named `rounded` in my own story.
- In the built Storybook: brand and tab title show DirectiveBench; MDX tables render; list
  markers render after the `preview.css` fix; the theme switch applies to MDX-only pages.

Stage 2, full gate on 2026-10-28: format, lint, typecheck, `pnpm test` (100% coverage),
`pnpm test:storybook` (24 files, 96 tests), `pnpm build`, `pnpm verify:pack`, `pnpm test:e2e`
(52 passed): all pass. Red first: with the component changes stashed, the motion test listed
the six files; the CardTitle test fails on an h3. Checked in the built Storybook: the seven
pages render, ArgTypes tables included, and the frozen states show in both themes.

Stage 3: format, lint, typecheck, `pnpm test` (100% coverage) and `pnpm test:storybook`
(58 files, 212 tests, 106 stories × 2 themes, also on a cold cache) pass; `build-storybook`
passes; `pnpm build` and `pnpm test:e2e` (52 passed) ran after P13.

Stage 4: lint, the token guard (59 tests), `pnpm test:storybook` (60 files, 214 tests) and
`build-storybook` pass; the built index has 40 docs pages and 107 stories, and every
catalogue link resolves.

Stage 5, all on 2026-10-28, cold cache:

| Command | Result |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck` | pass |
| `pnpm test` | pass, 100% coverage, 7 tasks |
| `pnpm test:storybook` | 60 files, 214 tests, 0 a11y violations, 0 exceptions |
| `pnpm --filter @directivebench/web build-storybook` | pass, 40 docs pages, 107 stories |
| `pnpm build && pnpm verify:pack` | pass; no Storybook file in the tarball |
| `pnpm test:e2e` | 52 passed |
| Browser pass (Playwright, 147 entries × 3 widths × 2 themes) | 0 page errors, 354 focus stops all visible, overflow only as listed above |

PR #140: all CI checks pass, including the first run of "Storybook (browser, both themes)"
(1m17s). At the maintainer's request (Q5) it is now a required status check on `main`
(branch protection, added through the GitHub API on 2026-10-28).

Not verified before the PR: the CI job itself (it runs once the PR exists); the pages at 320 and 768px
(stage 5); keyboard use of the Storybook UI.

Stage 5:
- Applied the accepted AGENTS.md diff (§2 step 13, §6, §7).
- Browser pass with Playwright over the built Storybook (all 147 entries, 320/768/1440 px,
  both themes): fixed two findings. Narrow-screen story frames were 320 px inside a padded
  canvas (now `w-full max-w-80`), and MDX tables, inline code and code blocks widened the docs
  pages at 320 px (now scroll or wrap through `.storybook/preview.css`, limited to
  documentation, never stories).
- P14 (accepted): PageHeader actions now wrap (`components/common.tsx`), which also fixes the
  overflow on real pages with several badges in the header. The PageHeader narrow-screen story
  asserts it and failed before the change. The RED/GREEN stories now fit 320 px.
- Remaining: the NotSandboxedBadge docs page is 33 px wider than 320 px because of its code
  block; cause not found.
- Token report. The guard (hex, palette classes, `text-xs`/`text-sm`, radius, status text,
  arbitrary values) finds nothing outside its six documented allowlist entries:
  `native-select.tsx` (Canvas colours), `card.tsx` (card-spacing token, header grid tracks),
  `results/[id]/page.tsx` (label grid tracks), `primitives.tsx` (Pre 28rem limit) and
  `content-tab.tsx` (40rem limit). Not covered by any guard: 229 uses of Tailwind scale
  values (`gap-1`, `mt-4`, `p-3`, `h-8`, `size-4`, …) in 46 files: 99 in `app/`, 81 in
  `components/` (generated files included) and 49 in Storybook files (mostly `max-w-80`
  frames and label gaps copied from the app). tokeny.md allows the scale where no `space-*`
  token fits; a stricter rule needs a separate decision.
- Counts: 40 documentation pages (8 Design system, 7 Foundations, 8 Primitives, 11 Product,
  6 Patterns), 18 components documented (7 primitives, 11 product), 6 patterns, 30 story
  files, 107 stories, 54 play functions, 214 story tests (both themes).

## Agent test (prepared, not run)

The maintainer runs this in a new session, with no other context than the repository. Every
place where the agent had to guess is either filled in on the Storybook pages or added to
"What is missing" (SPEC-122 AC-9).

**Prompt for the agent:**

> Read `apps/web/design-system.md` and the Storybook under `apps/web/stories/`. Then design
> and build, in `apps/web` only, the editing UI of issue 64 on the artifact detail page
> (`/artifacts/[id]`): add and remove tags, edit the notes, and assign or unassign one
> benchmark suite. Writes go through `@directivebench/database` with Zod-validated server
> actions. Do not change tokens or `components/ui` without asking. Before you write code,
> list every decision the documentation did not settle (component, state, wording, spacing).
> When you finish, run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:storybook` and
> say which Storybook pages you used.

**Why this screen:** the app does not have it; it needs a form (Form pattern), a list of
removable values (Filtered list chips), a long text field and a choice from a list, so it
touches three primitives on "What is missing" (Textarea, Combobox or tag input, Checkbox for
"unassign"). It shows whether the agent reuses documented patterns or improvises.

**What to record afterwards:** each guess the agent listed, whether the documentation answered
it, and the fix (a page update or a "What is missing" row).

## Problems and deviations

- `parameters.nextjs.appDirectory: true` broke every story on Next 16.4 and was removed from
  the global parameters (lesson recorded). Stage 3 must solve it per story for `Nav`.
- axe found `heading-order` on every page composition (h1 then the `CardTitle` h3). Recorded
  as proposal P6 with a documented story exception, not fixed, because it changes a
  component.
- The prompt asks for running text of about 65 characters, overlay elevation and motion rules
  the materials do not fully settle: proposals P7 to P9.

## Lessons recorded

- `.ai/lessons/2026-10-28-storybook-mdx-file-name-sets-the-docs-id.md`

- `.ai/lessons/2026-10-28-storybook-nextjs-vite-app-directory-breaks-on-next-16-4.md`
- `.ai/lessons/2026-10-28-tailwind-preflight-strips-mdx-list-markers.md`

## Follow-ups

See SPEC-122 §18 and §19.
