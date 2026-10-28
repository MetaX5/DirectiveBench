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

`apps/web/tsconfig.json` includes `.storybook/*.ts(x)`, which the `**/*` globs skip, so the
configuration is typechecked. The root gets a `test:storybook` script. CI gets a new job, "Storybook (browser, both themes)",
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

- `Nav` and `AutoRefresh` need App Router mocks. Set globally, `parameters.nextjs.appDirectory`
  breaks every story on Next 16.4 (stage 1,
  [lesson](../lessons/2026-10-28-storybook-nextjs-vite-app-directory-breaks-on-next-16-4.md)),
  and per story as well; stage 3 stubs `usePathname` from
  `@storybook/nextjs-vite/navigation.mock` instead.
- `ContentTab` cannot render in the browser: `lib/artifacts.ts` imports `ARTIFACT_TYPES` from
  `@directivebench/core`, whose index pulls Node modules (`node:buffer`). It moves to "What is
  missing" with that reason; the Markdown it renders is documented on its own.
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

- [x] AC-1: Storybook starts and builds from `apps/web` with the add-ons in FR-122-1. MDX
      tables render.
- [ ] AC-2: every primitive and product component in §11 has a page with the 13 sections and
      a state matrix.
- [x] AC-3: every pattern in §11 has all its data states, and the form pattern also has its
      submit states.
- [ ] AC-4: story tests pass in both themes with no a11y violations, or each one is a
      documented exception. They run in CI.
- [x] AC-5: the token guard covers Storybook files and finds no value outside the tokens.
- [x] AC-6: "What is missing" lists the missing screens and components with reasons.
- [x] AC-7: `apps/web/design-system.md` exists, and the AGENTS.md diff has been proposed.
- [x] AC-8: the quality gate passes. Storybook files stay out of the tarball and out of the
      coverage scope.
- [ ] AC-9: the agent test is prepared in the run log, and the maintainer runs it in a new
      session.

## 17. Dependencies

- Depends on SPEC-119, SPEC-120 and SPEC-121 (#132, merged).
- Related to #123 (dash ban).
- New dev dependencies: §10.

## 18. Resolved questions

The maintainer answered on 2026-10-28 and accepted every proposal.

1. Q1 Tone of messages: plain and factual, no exclamation marks. Errors say what happened
   and what to do; buttons are a verb plus an object.
2. Q2 Motion: transitions of colour and opacity only, up to 150 ms, none under
   `prefers-reduced-motion`, and no decorative animation.
3. Q3 Icons: lucide only. 16 px by default, 12 to 14 px inside small controls. An icon-only
   control needs an accessible name. An icon never carries status alone.
4. Q4 Em dashes in component copy: fixed in this work. `MockBadge` and `PlannedSection` in
   `components/common.tsx` and the E2E constant change in stage 1. The rest of the cleanup
   stays with #123.
5. Q5 The CI job "Storybook (browser, both themes)" becomes a required check. The maintainer
   changes branch protection after the job exists on `main`.

Accepted proposals:

- P1: keep `primitives.tsx` re-exports as the import path pages use, and document
  `components/ui/*` as the source.
- P2: remove `'use client'` from `components/ui/table.tsx`, which has no client code.
- P3: keep the unused generator parts (`CardAction`, `CardFooter`, `TableFooter`,
  `TableCaption`, `NativeSelectOptGroup`), documented as available but unused.
- P4: colocate component stories (`components/**/x.stories.tsx`). MDX pages, patterns and
  blocks go in `apps/web/stories/`.
- P5: use our own theme decorator instead of `@storybook/addon-themes`.

Proposals from stage 1, accepted by the maintainer on 2026-10-28 (P2, P6 and P9 implemented in
stage 2; P7, P8 and P10 are documentation rules):

- P6: every page jumps from the `PageHeader` h1 to the `CardTitle` h3, which axe reports as
  `heading-order` (WCAG 1.3.1). Render `CardTitle` as an h2 in `components/ui/card.tsx`, or
  give it a level prop. Until then, stories that compose a page carry a documented exception
  (`stories/blocks/a11y.ts`).
- P7: running text is at most about 65 characters per line (`max-w-prose`). The materials set
  no line length.
- P8: overlays that are not built yet (Dialog, menus, Toast) separate with `border` and the
  `popover` fill, without a shadow. The materials do not decide overlay elevation.
- P9: Button and Badge use `transition-all`, and Button moves 1px while pressed, also under
  `prefers-reduced-motion`, against Q2. Add `motion-reduce:transition-none` to both and
  `motion-reduce:active:translate-y-0` to Button.
- P10: rules that come only from the maintainer's prompt (no emoji as icons, no sparkles as
  the AI symbol) cite the prompt file as their source; confirm that counts as a source under
  prompt rule 3.

Proposals from stage 2, accepted by the maintainer on 2026-10-28 (P13 implemented in stage 3;
P11 and P12 are documentation rules):

- P11: loading state. No component has one. Disable the control and say what is happening in
  a `role="status"` message, as `/repositories` does while it checks a path; no spinner.
- P12: at most one `default` button per form or section, as on every current page.
- P13: `Pre` and the `Table` scroll container scroll when content is long or wide, but are not
  tab stops (axe `scrollable-region-focusable`). Give `Pre` `tabIndex={0}`, and give the table
  container `tabIndex={0}` with `role="region"` and the table's name. Until then two stories
  carry a documented exception (`stories/blocks/a11y.ts`).

Proposal from stage 5, accepted by the maintainer on 2026-10-28 and implemented:

- P14: `PageHeader` actions use `flex` without `flex-wrap` (`components/common.tsx`), so three
  badges in the actions overflow at 320 px, as on a mock benchmark's page. Add `flex-wrap`.

## 19. Future extensions

- Extracting presentational components from pages, which needs a separate spec.
- The primitives that planned screens need (§11).
- Full-screen stories.
- Publishing Storybook.

## 20. Implementation status

- **Implemented and verified (stage 1, 2026-10-28):**
  - Storybook 10.6.2 in `apps/web` with docs (GFM tables), a11y as errors, Vitest story tests
    in the `storybook-light` and `storybook-dark` projects, the scripts of §10 and the CI job
    (FR-122-1, FR-122-2). Verified by `pnpm test:storybook` (22 tests) and
    `build-storybook`, and by checking tables and list markers in the built pages.
  - The theme switcher sets `.dark` on `<html>`, for stories and for MDX pages without stories
    (FR-122-2). Verified in the built Storybook in both themes.
  - Only the name DirectiveBench in the UI and tab title; telemetry, what's-new notices and
    onboarding checklists off (FR-122-6). Verified in the built Storybook.
  - The seven Foundations pages. Colour measures every `tokeny.md` pair on the stored values in
    both themes: all pass, and no value differs from `tokeny.md` by more than 0.25.
  - The SPEC-121 guards cover `stories/`, `.storybook/` and MDX pages; a dash check covers the
    Storybook files (FR-122-4, FR-122-7). Verified red first.
  - Storybook stays out of the tarball and the unit-coverage scope (FR-122-5). Verified by
    `pnpm verify:pack` and `pnpm test`.
  - The mock and planned labels no longer contain an em dash (Q4). Verified by `pnpm test:e2e`.
- **Implemented and verified (stage 2, 2026-10-28):**
  - "Parameters in force" and 13-section pages for Button, Badge, Card, Input, NativeSelect,
    Table and Pre, each with a Playground, variants, a state matrix (hover, focus and pressed
    frozen through `data-preview-state`, read only by `.storybook/states.css`), long content
    at 320px and play functions (AC-2 for the primitives). Verified by `pnpm test:storybook`
    (48 stories in both themes, 96 tests) and in the built Storybook.
  - P6: `CardTitle` is an h2 and the artifact content heading an h3; the page compositions
    pass axe `heading-order` without an exception. P9 and Q2: every transition has
    `motion-reduce:transition-none` and the button press shift is `motion-safe:`. P2: `table.tsx`
    has no `'use client'`. Guard tests cover the heading level and the motion pairing, both
    shown red first. Verified by `pnpm test:e2e` (52 passed).
- **Implemented and verified (stage 3, 2026-10-28):**
  - P13: `Pre` and the `Table` scroll container are tab stops with the focus ring; a named
    table's container is a region with that name. The stage 2 exceptions are gone. Verified
    by the story tests and `pnpm test:e2e` (52 passed).
  - Product pages with 13 sections and stories for PageHeader, Nav, ThemeToggle, EmptyState,
    NotInitialized, PlannedSection, StatusBadge, JobStatusBadge, MockBadge, NotSandboxedBadge
    and Markdown (11 of the 12 planned; ContentTab is on "What is missing", §14).
  - Six patterns, each state its own story: Form (idle, pending, field error, general error,
    success, double submit blocked), Filtered list, Detail view, Risky-action confirmation,
    RED/GREEN result (mock labelled) and Job progress (AC-3).
  - Verified by `pnpm test:storybook`: 106 stories, 212 tests in both themes, also on a cold
    cache; `build-storybook` and a look at the built pages.
- **Implemented and verified (stage 4, 2026-10-28):**
  - The eight Design system pages: Start here (character, five steps, component table),
    Components (live catalogue linked to every page; its story test checks the 18 links),
    How to choose, Usage and accessibility, Content, What to avoid, What is missing (locked
    and missing components, pattern gaps, backlog coverage) and Contributing (with the
    technical note on the Storybook base, FR-122-6).
  - `apps/web/design-system.md` for agents (FR-122-8). The AGENTS.md reference is proposed as
    a diff in the run log, not applied (AC-7).
  - Number formats corrected in the stories and pages to the app's formatters
    (`formatScore`, `formatDelta`).
  - Verified by `pnpm test:storybook` (214 tests), `build-storybook` (40 docs pages, 107
    stories, every catalogue link resolves) and a look at the built pages.
- **Verified in stage 5 (2026-10-28):**
  - Full gate on a cold cache: format, lint, typecheck, `pnpm test` (100% coverage),
    `pnpm test:storybook` (214 tests), `build-storybook`, `pnpm build`, `pnpm verify:pack`
    (no Storybook file in the tarball) and `pnpm test:e2e` (52 passed).
  - Token guard: no value outside the tokens beyond the six documented allowlist entries of
    SPEC-121. Values on the Tailwind scale that no guard covers are counted in the run log.
  - a11y: no violations and no exceptions in 107 stories in both themes.
  - Browser pass over all 147 entries at 320, 768 and 1440 px in both themes: no page errors;
    keyboard focus visible on all 354 elements reached by Tab; no horizontal page scroll
    except one docs page (NotSandboxedBadge, 33 px from a code block). The RED/GREEN result
    stories overflowed at 320 px until P14 made the PageHeader actions wrap; a play function
    in the PageHeader narrow-screen story guards it (shown red first).
  - The AGENTS.md change (design-system rule, `pnpm test:storybook` in the gate and the
    commands) was applied after the maintainer accepted it.
- **Not verified:** AC-2 is met for 18 of the 19 components in §11 (ContentTab is on "What is
  missing"); AC-4's CI run happens only once the PR is open; AC-9's agent test is prepared in
  the run log and waits for the maintainer. The spec stays `draft` until those are done.

## 📋 Implementation Plan

### Stage 1: foundations (done 2026-10-28)

1. Install and configure Storybook (FR-122-1, FR-122-2, FR-122-6) with the scripts and the CI
   job. Check `package.json` for dependencies outside the plan.
2. Load `globals.css` and Figtree. Recompute contrast for every `tokeny.md` pair from the
   stored values, and stop if any pair fails.
3. Write the seven Foundations pages, using real CSS variables and blocks.
4. Extend `design-system-scope.json` and the guards to the Storybook files.
5. Replace the em dashes in `MockBadge` and `PlannedSection` copy and the E2E constant (Q4).

### Stage 2: primitives, in batches of about six (done 2026-10-28, one batch of seven)

5. Write down the shape, density and state parameters in force, with their sources.
6. Button, Badge, Card, Input, NativeSelect, Table, Pre: 13-section pages, state matrices and
   play functions.

### Stage 3: product components and patterns (done 2026-10-28)

7. Product components from §11, with data states.
8. Patterns from §11, each state as its own story.

### Stage 4: pages that teach (done 2026-10-28)

9. The eight Design system pages and `apps/web/design-system.md`, plus the AGENTS.md diff as
   a proposal.

### Stage 5: verification and report (done 2026-10-28; PR after the maintainer's "dalej")

10. Full gate and story tests in both themes; guard and a11y report; browser pass; counts.
11. Write the agent test into the run log. Update the spec status, the run log and lessons.
    Open the PR after the maintainer's "dalej".
