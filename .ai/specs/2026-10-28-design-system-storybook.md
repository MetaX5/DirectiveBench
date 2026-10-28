---
id: SPEC-122
title: Design-system documentation in Storybook
status: draft
created: 2026-10-28
updated: 2026-10-28
category: feature
related: [SPEC-119, SPEC-120, SPEC-121, SPEC-116, SPEC-118]
---

# SPEC-122 — Design-system documentation in Storybook

## 1. Summary

Storybook in `apps/web` becomes the operating manual of the DirectiveBench design system.
Three readers use it: a developer building a screen, an AI agent building a screen, and a
designer checking a screen. It documents the existing tokens and components, plus four
patterns. It does not redesign anything and does not build full screens. The agent prompt is
[`briefs/2026-10-27-design-system-storybook.md`](briefs/2026-10-27-design-system-storybook.md)
(issue [#134](https://github.com/MetaX5/DirectiveBench/issues/134)).

## 2. Motivation and problem statement

The product style is decided: SPEC-119 (preset), SPEC-120 (tokens) and SPEC-121 (migration and
CI guard). What is missing is guidance on using it. Nothing says when to use each component,
how its states behave, which pattern a screen follows or what to avoid, so every new screen
involves guesswork. The inventory of 2026-10-28 (run log) found:

- four improvised primitives inside pages: link tabs, notice paragraphs, `dl` grids and
  `<details>` disclosures;
- 14 product components locked inside page files.

## 3. Goals

- A developer or an agent builds a new screen from the documentation without guessing.
- Every component in the plan has a 13-section page and a state matrix. Every pattern covers
  all its data states.
- Every documented rule names its source (rule 3 of the prompt), or it is marked as a
  proposal.
- Story a11y tests and the SPEC-121 token guard are clean in both themes, and run in CI.

## 4. Non-goals

The following are maintainer decisions of 2026-10-27:

- No full-screen stories, and no extraction of components from `apps/web/app`.
- No restyling.
- No new components without a screen that needs them.
- No publishing of Storybook.

Changes to tokens or `tokeny.md` need the maintainer's consent.

## 5. User stories

- As a developer, I find the right component and pattern for a screen, and their states, in
  one place.
- As an AI agent, I read `apps/web/design-system.md` and know the imports, the tokens and
  what to avoid.
- As a designer, I check a screen against documented rules, each with its source.

## 6. Functional requirements

1. FR-122-1: Storybook MUST run from `apps/web`. It uses the framework `@storybook/nextjs-vite`
   with the add-ons docs, a11y (`parameters.a11y.test = 'error'`) and Vitest. MDX MUST render
   GFM tables (`remark-gfm`).
2. FR-122-2: the theme switcher MUST set `.dark` on `<html>`, so portalled overlays get the
   theme. Story tests MUST run in both themes.
3. FR-122-3: stories MUST use the real components from `apps/web/components`. The only
   exception is documentation helper blocks, such as swatches and token tables, which live in
   `apps/web/stories/blocks`.
4. FR-122-4: the scope in `design-system-scope.json` MUST extend to the stories, MDX pages and
   blocks (SPEC-121 FR-121-3). A block that must break a rule gets a commented exception.
5. FR-122-5: Storybook MUST NOT enter the npm tarball. It MUST NOT change the 100% unit
   coverage scope, and it MUST NOT break `pnpm build`.
6. FR-122-6: the Storybook UI MUST show only the name DirectiveBench, with onboarding,
   what's-new notices and telemetry turned off.
7. FR-122-7: app-authored text in stories and MDX MUST NOT contain en or em dashes, and MUST
   meet contrast in both themes (AGENTS.md §7).
8. FR-122-8: `apps/web/design-system.md` MUST summarise the system for agents. The AGENTS.md
   reference is proposed to the maintainer as a diff.

## 7. Non-functional requirements

- No remote requests: Figtree comes from the local Fontsource package (ADR-0001).
- Story tests are deterministic and need no credentials. The browser is the Chromium already
  used by the Playwright E2E tests.

## 8. Domain entities and contracts

None. Example data is invented but realistic (repositories, skills, suites, RED/GREEN
results), and every mock agent result is labelled as mock.

## 9. Data flow

Stories pass data through props. They never import `lib/db.ts` or runtime code from
`@directivebench/database`; type imports are allowed.

## 10. API and interface design

| Script (apps/web) | Command |
|---|---|
| `storybook` | `storybook dev -p 6006 --no-open` |
| `build-storybook` | `storybook build -o storybook-static` |
| `test-storybook` | `vitest run --config vitest.storybook.config.ts`, with two projects, light and dark |

The root gets a `test:storybook` script. CI gets a new job, "Storybook (browser, both themes)",
which installs Chromium, runs `pnpm test:storybook` and runs `build-storybook`.

New devDependencies, all in `apps/web`, pinned to releases at least two weeks old where
possible:

| Package | Version | Reason |
|---|---|---|
| `storybook` | 10.6.2 | CLI and core (newest release older than two weeks) |
| `@storybook/nextjs-vite` | 10.6.2 | The recommended Next framework; supports Next 16, React 19 and Vite 8; mocks `next/navigation` |
| `@storybook/addon-docs` | 10.6.2 | MDX pages and autodocs |
| `@storybook/addon-a11y` | 10.6.2 | axe checks in the UI and in tests |
| `@storybook/addon-vitest` | 10.6.2 | Stories as Vitest browser tests |
| `@vitest/browser-playwright` | 5.0.5 | Browser provider. It must match the root `vitest` 5.0.5 exactly, so it is only 13 days old (exception) |
| `playwright` | 1.64.1 | Explicit peer of the provider; the same Chromium as `@playwright/test` |
| `vite` | 8.3.4 | Peer of the framework; already in the lockfile |
| `remark-gfm` | 4.0.1 | Markdown tables in MDX (prompt rule 7) |

The theme switcher is a small decorator in `.storybook/preview.tsx` instead of
`@storybook/addon-themes` (proposal P5).

## 11. UI/UX considerations

Menu tree, with the approximate number of stories in parentheses:

```text
Design system   (8 MDX pages)
  Start here · Components · How to choose · Usage and accessibility · Content
  What to avoid · What is missing · Contributing
Foundations     (7 MDX pages)
  Colour · Typography · Spacing and layout · Shape and depth · Motion · Icons · Themes
Primitives      (7 pages, ~45 stories)
  Button · Badge · Card · Input · NativeSelect · Table · Pre
Product         (~11 pages, ~45 stories)
  App shell: PageHeader · Nav · ThemeToggle
  States: EmptyState · NotInitialized · PlannedSection
  Benchmarking (E06, SPEC-118): StatusBadge · JobStatusBadge · MockBadge · NotSandboxedBadge
  Registry (E02): ContentTab · Markdown
Patterns        (6 pages, ~30 stories)
  Form · Filtered list · Detail view · Risky-action confirmation
  RED/GREEN result (mock) · Job progress
```

The total is about 120 stories and 39 pages. `AutoRefresh` renders nothing, so it gets a
note on the Usage page instead of stories.

Where each primitive, product component and pattern is needed:

| Item | Screen that needs it |
|---|---|
| Button | every form: `/repositories`, `/artifacts`, `/benchmarks/[id]`, `/executions` |
| Badge | statuses and labels on every list and detail page |
| Card | every page section |
| Input | register form (`/repositories`), artifact search (`/artifacts`) |
| NativeSelect | artifact filters (`/artifacts`) |
| Table | every list page |
| Pre | definitions and raw output (`/benchmarks/[id]`, `/results/[id]`, `/settings`) |
| PageHeader, Nav, ThemeToggle | every page (`app/layout.tsx`) |
| EmptyState, NotInitialized, PlannedSection | empty lists; missing database; `/builder`, `/providers` |
| StatusBadge, JobStatusBadge, MockBadge, NotSandboxedBadge | `/`, `/results`, `/results/[id]`, `/executions`, `/benchmarks/[id]` |
| ContentTab, Markdown | `/artifacts/[id]?tab=content` |
| Form pattern | `/repositories` register, `/benchmarks/[id]` Run |
| Filtered list pattern | `/artifacts` |
| Detail view pattern | `/artifacts/[id]`, `/results/[id]` |
| Risky-action confirmation | "Register anyway" on `/repositories` |
| RED/GREEN result (mock) | `/results/[id]`, SPEC-118 |
| Job progress | `/executions`, the scan status on `/repositories` |

On "What is missing", with reasons:

- **Product components locked in page files** (this work does not extract them): `Stat`,
  `AuthCell`, the link `Tabs`, `ComparisonBadge`, `GroupTable`, `ScoreBar`, `VariantCard`,
  `AssertionDetails`, `AgentProfileCard`, `FileTree` and the artifact tab bodies.
- **Primitives improvised inline:** Tabs, Alert or notice, Disclosure, DescriptionList,
  Field or Label, Tooltip, Meter.
- **Primitives that planned screens need:**
  - Dialog and AlertDialog: categories (#22), Builder (SPEC-109), UI approval (SPEC-118 §19).
  - Checkbox: bulk assign (#22), approval.
  - Textarea and Combobox: categories (#22), Builder (SPEC-109).
  - Toast: categories (#22), settings (SPEC-115).
  - Pagination and diff view: SPEC-113.
  - Command palette: SPEC-116.
- **Screens:** the full screens are missing. They need presentational components extracted
  from `app/`, which is a separate decision and spec.

## 12. Security considerations

No runtime surface changes. Storybook is a development tool and is never published. Stories
never touch the database or run commands.

## 13. Error handling

A11y or render failures fail the story tests and the CI job. A documented exception records
its reason in the story's parameters.

## 14. Edge cases

- `Nav` and `AutoRefresh` need App Router mocks (`parameters.nextjs.appDirectory`).
- `ThemeToggle` needs `ThemeProvider` with `forcedTheme`, so it does not fight the decorator.
- `components/ui/table.tsx` carries `'use client'` without a reason (proposal P2).
- `tsconfig` includes `**/*.tsx`, so a broken story fails `pnpm typecheck` and `next build`.

## 15. Testing strategy

- Story tests: the Vitest browser mode in Chromium, with a11y as errors, run in a light
  project and a dark project.
- Play functions cover the main behaviour of every interactive component and pattern.
- The SPEC-121 guard extends to the Storybook files.
- The existing gate, E2E included, must still pass, along with `verify:pack`.
- Stage 5 includes a manual browser pass: 320, 768 and 1440 px, both themes, keyboard, and
  overlays.

## 16. Acceptance criteria

- [ ] AC-1: Storybook starts and builds from `apps/web` with the add-ons in FR-122-1. MDX
      tables render.
- [ ] AC-2: every primitive and product component in §11 has a page with the 13 sections and
      a state matrix.
- [ ] AC-3: every pattern in §11 has all its data states, and the form pattern also has its
      submit states.
- [ ] AC-4: story tests pass in both themes with no a11y violations, or each one is a
      documented exception. They run in CI.
- [ ] AC-5: the token guard covers Storybook files and finds no value outside the tokens.
- [ ] AC-6: "What is missing" lists the missing screens and components with reasons.
- [ ] AC-7: `apps/web/design-system.md` exists, and the AGENTS.md diff has been proposed.
- [ ] AC-8: the quality gate passes. Storybook files stay out of the tarball and out of the
      coverage scope.
- [ ] AC-9: the agent test is prepared in the run log, and the maintainer runs it in a new
      session.

## 17. Dependencies

- Depends on SPEC-119, SPEC-120 and SPEC-121 (#132, merged).
- Related to #123 (dash ban).
- New dev dependencies: §10.

## 18. Open questions

For the maintainer (stage 0):

1. Q1 Tone of messages. The materials say nothing. Proposal: plain and factual, no
   exclamation marks. Errors say what happened and what to do; buttons are a verb plus an
   object.
2. Q2 Motion. The app only uses colour transitions. Proposal: transitions of colour and
   opacity only, up to 150 ms, none under `prefers-reduced-motion`, and no decorative
   animation.
3. Q3 Icons beyond lucide. Proposal: lucide only. 16 px by default, 12 to 14 px inside small
   controls. An icon-only control needs an accessible name. An icon never carries status
   alone.
4. Q4 Existing em dashes in component copy (`MockBadge` "Mock agent — not an AI evaluation",
   `PlannedSection` "Planned — not implemented"). Stories would show them. Fix the two
   strings here (`components/common.tsx` plus the E2E constant), or leave them to #123?
5. Q5 Should the CI job "Storybook (browser, both themes)" become a required check?
   Branch protection is a repository setting the maintainer changes.

Proposals for the maintainer's decision:

- P1: keep `primitives.tsx` re-exports as the import path pages use, and document
  `components/ui/*` as the source.
- P2: remove `'use client'` from `components/ui/table.tsx`, which has no client code.
- P3: keep the unused generator parts (`CardAction`, `CardFooter`, `TableFooter`,
  `TableCaption`, `NativeSelectOptGroup`), documented as available but unused.
- P4: colocate component stories (`components/**/x.stories.tsx`). MDX pages, patterns and
  blocks go in `apps/web/stories/`.
- P5: use our own theme decorator instead of `@storybook/addon-themes`, to save one
  dependency.

## 19. Future extensions

- Extracting presentational components from pages, which needs a separate spec.
- The primitives that planned screens need (§11).
- Full-screen stories.
- Publishing Storybook.

## 20. Implementation status

- **Implemented:** none.
- **Not implemented:** all. Stage 0 (inventory and plan) is complete and waits for the
  maintainer's "dalej".

## 📋 Implementation Plan

### Stage 1: foundations

1. Install and configure Storybook (FR-122-1, FR-122-2, FR-122-6) with the scripts and the CI
   job. Check `package.json` for dependencies outside the plan.
2. Load `globals.css` and Figtree. Recompute contrast for every `tokeny.md` pair from the
   stored values, and stop if any pair fails.
3. Write the seven Foundations pages, using real CSS variables and blocks.
4. Extend `design-system-scope.json` and the guards to the Storybook files.

### Stage 2: primitives, in batches of about six

5. Write down the shape, density and state parameters in force, with their sources.
6. Button, Badge, Card, Input, NativeSelect, Table, Pre: 13-section pages, state matrices and
   play functions.

### Stage 3: product components and patterns

7. Product components from §11, with data states.
8. Patterns from §11, each state as its own story.

### Stage 4: pages that teach

9. The eight Design system pages and `apps/web/design-system.md`, plus the AGENTS.md diff as
   a proposal.

### Stage 5: verification and report

10. Full gate and story tests in both themes; guard and a11y report; browser pass; counts.
11. Write the agent test into the run log. Update the spec status, the run log and lessons.
    Open the PR after the maintainer's "dalej".
