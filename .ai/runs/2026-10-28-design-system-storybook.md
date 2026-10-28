---
title: Design-system documentation in Storybook (SPEC-122, #134)
date: 2026-10-28
agent: Claude Code / claude-opus-5-5
trigger: maintainer request ("zaczynaj 134"), issue #134, prompt .ai/specs/briefs/2026-10-27-design-system-storybook.md
status: in-progress
branch: feat/design-system-storybook
specs: [SPEC-122, SPEC-119, SPEC-120, SPEC-121]
---

# Run: design-system documentation in Storybook

## State

- **Completed stages:** 0 (inventory and plan), 1 (foundations).
- **Approved by the maintainer:** the stage 0 plan, Q1–Q5 and P1–P5 (2026-10-28; Q4: fix the
  two em dashes here; Q5: the Storybook CI job becomes required). #132 was merged first, as
  the prompt requires.
- **Open questions:** proposals P6 to P10 from stage 1 (SPEC-122 §18).
- **Next step:** wait for "dalej" and the answers to P6 to P10, then start stage 2
  (primitives, first batch).

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

Not verified: the CI job itself (it runs once the PR exists); the pages at 320 and 768px
(stage 5); keyboard use of the Storybook UI.

## Problems and deviations

- `parameters.nextjs.appDirectory: true` broke every story on Next 16.4 and was removed from
  the global parameters (lesson recorded). Stage 3 must solve it per story for `Nav`.
- axe found `heading-order` on every page composition (h1 then the `CardTitle` h3). Recorded
  as proposal P6 with a documented story exception, not fixed, because it changes a
  component.
- The prompt asks for running text of about 65 characters, overlay elevation and motion rules
  the materials do not fully settle: proposals P7 to P9.

## Lessons recorded

- `.ai/lessons/2026-10-28-storybook-nextjs-vite-app-directory-breaks-on-next-16-4.md`
- `.ai/lessons/2026-10-28-tailwind-preflight-strips-mdx-list-markers.md`

## Follow-ups

See SPEC-122 §18 and §19.
