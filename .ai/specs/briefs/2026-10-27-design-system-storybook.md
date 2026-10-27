# Design-system documentation in Storybook (agent prompt)

- Date: 2026-10-27
- Category: feature
- Tracking issue: #134
- Depends on: #132 (token migration and design-system guard in CI) merged first
- Related: #123 (no en/em dashes in app-authored UI copy)
- Decision already made: stage 3 ends at patterns; no full-screen stories and no
  extraction of presentational components from `apps/web/app` in this work.

This file is the prompt for the agent session that builds the design-system documentation.
Paste it as the first message, or tell the agent to read this file and follow it. It was
adapted from a generic design-system prompt to this repository (maintainer review,
2026-10-27): the existing preset is the product style, sources map to this repository's
identifiers, components are limited to what screens need, and the work follows AGENTS.md.

---

# Task

Build the design-system documentation for DirectiveBench in Storybook. Storybook is an
operating manual, not a gallery. Three readers use it: a developer building a screen, an AI
agent building a screen, and a designer checking whether a screen follows the system.

Done means: a developer or agent builds a new screen from this documentation without
guessing. They know which component to use and why, how to compose it with others, which
tokens to use, how every state behaves and what not to do.

Talk to the maintainer in Polish. Everything that goes into the repository (code, MDX,
documentation, spec, run log) is written in English.

# Materials

- Repository instructions: AGENTS.md (it overrides this prompt; if they conflict, stop and
  ask) and .ai/lessons.md
- Brief: .ai/specs/product-brief.md (decisions D01–D08; note that A01–A04 are product
  assumptions, not anti-references)
- Backlog: .ai/specs/backlog.md and the GitHub issues
- Specifications: .ai/specs/ (especially SPEC-116 navigation, SPEC-118 benchmark S1,
  SPEC-119 shadcn preset, SPEC-120 tokens)
- Tokens: apps/web/tokeny.md (table, contrast pairs, decisions D1–D10) and
  apps/web/app/globals.css (implementation)
- Component base: shadcn, style radix-lyra, preset b3Rq8QfWi (apps/web/components.json);
  components live in apps/web/components/ui
- Storybook lives in apps/web. Do not create a new package.
- Product interface language: English

# How you work

Work in stages 0 to 5. After each stage, stop, show what you did and what you verified,
and wait for the maintainer's "dalej". Never move to the next stage on your own.

Before stage 0, check that #132 is merged. If it is not, stop and say so.

Work on the branch feat/design-system-storybook. Commit after each stage (Conventional
Commits). Push and open the PR only after stage 5 and the maintainer's "dalej".

Track state the AGENTS.md way, not in a separate PROGRESS.md:
- a spec .ai/specs/<date>-design-system-storybook.md (next free SPEC-1xx, status draft,
  listed in the index),
- a run log .ai/runs/<date>-design-system-storybook.md with a "State" section: completed
  stages, decisions the maintainer approved, open questions, next step.
In a new session, read the run log and the spec first and continue where the work stopped.

# Rules that must not be broken

1. The product style is decided: shadcn preset Lyra b3Rq8QfWi (SPEC-119) with the
   accessibility fixes and tokens of SPEC-120. Shape (square corners), density (32px
   controls, 12px control text), Figtree, neutral/lime palette. Do not redesign it. Where
   the materials are silent, ask. Mark anything you add yourself as a proposal.
2. Every value in components comes from a token. No hex, rgb, hsl or oklch colours outside
   the --palette-* layer of globals.css, no Tailwind palette classes (bg-zinc-900,
   text-white) and no arbitrary values (p-[13px]).
3. Every rule in the documentation names its source: SPEC-nnn with an FR or AC number, a
   brief decision (D01–D08), an ADR (ADR-nnnn), a tokeny.md decision (D1–D10), a lesson from
   .ai/lessons/, WCAG or WAI-ARIA. A rule without a source is marked as a proposal and
   listed in the report for the maintainer's decision.
4. Stories use the real components from apps/web/components. No HTML copies and no
   components made only for Storybook. Exception: documentation helper blocks (colour
   swatch, token table) kept in the Storybook directory. Stage 3 patterns are compositions
   of existing components inside stories.
5. Do not add components, variants or dependencies outside the approved plan. AGENTS.md
   forbids speculative abstractions, and SPEC-119 §19 adds components only when a concrete
   feature needs them. Put what is missing on the "What is missing" page. After every CLI
   command (shadcn, storybook init) check package.json and remove dependencies outside the
   plan. Justify every new dependency in the spec.
6. Example data is invented but realistic and taken from the brief and specs: repositories,
   skills, benchmark suites, RED/GREEN results. No lorem ipsum. Mock agent results are always
   labelled as mock (AGENTS.md §7).
7. MDX tables: without remark-gfm, Markdown tables render as raw text. Add the plugin or use
   JSX tables. Check every page in the built Storybook.
8. The theme switcher sets the .dark class on <html>, as next-themes does in the app, so
   dialogs and menus rendered outside the story get the theme too.
9. The Storybook UI shows only the name DirectiveBench. Record the base's origin in a
   technical note. Turn off the onboarding checklist and new-version notices.
10. Do not change code in apps/web/app and do not extract components from pages. Allowed:
    Storybook configuration, scripts, stories and MDX, and changes in apps/web/components
    approved in the plan. Publish nothing.
11. Do not delete or rewrite tokens, themes, components, tokeny.md, the SPEC-120 tests or
    the #132 guards without the maintainer's consent. Propose the change with a reason and
    wait.
12. UI text, documentation pages included, uses no en dash or em dash (U+2013, U+2014)
    (AGENTS.md §7, #123). Every visible text meets contrast in both themes: 4.5:1 (text),
    3:1 (large text and UI elements).
13. The AGENTS.md quality gate applies: pnpm lint && pnpm typecheck && pnpm test (100%
    coverage, no widened exclusions), pnpm build && pnpm verify:pack, pnpm test:e2e.
    Storybook must not break the build or the npm CLI package (stories and configuration
    stay out of the tarball).

# Target Storybook structure

Design system
  Start here: how to build a screen
  Components: catalogue with live preview and link
  How to choose
  Usage and accessibility
  Content
  What to avoid
  What is missing
  Contributing
Foundations: Colour, Typography, Spacing and layout, Shape and depth, Motion, Icons, Themes
Primitives: components from components/ui
Product: existing product components from components/ (outside ui/), grouped by epic
Patterns: form, filtered list, detail view, risky-action confirmation and key patterns from
  the backlog

No "one page per epic with flow and screens": screens are not built in Storybook (decision:
stop at patterns). Show epic coverage on the "What is missing" page.

# Stage 0. Inventory and plan

Read the materials and inspect the repository: pnpm, Next.js, React, Tailwind 4,
globals.css, components/ui, components/, pages in app/, e2e tests, and the guards #132
added. Write only the draft spec and the run log. Show:

1. The decisions already in force, in ten numbered lines (SPEC-119, SPEC-120 D1–D10,
   brief D0x, AGENTS.md §7).
2. What the materials are missing, at most five questions at a time (for example tone of
   messages, motion, icons beyond lucide).
3. The technical plan: a Storybook version that supports Next 16, React 19 and Tailwind 4
   (check the official framework, for example @storybook/nextjs-vite), add-ons (docs,
   a11y, Vitest for interaction and accessibility tests), the storybook, build-storybook
   and test-storybook scripts for both themes, how it enters CI, how it stays out of the
   tarball and how it keeps 100% coverage. List new dependencies with reasons.
4. The list of primitives, product components and patterns, derived from the existing
   pages in app/ and the screens planned in the specs, each with the screen that needs it.
   Components with no screen go to "What is missing", not into the plan. Product
   components locked inside page files (for example ScoreBar in
   app/results/[id]/page.tsx) also go to "What is missing", because this work does not
   extract them.
5. The menu tree and the approximate number of stories.
6. What stays unchanged, what you want to change and what you want to remove in the
   existing system, each with a reason, for the maintainer's decision.

# Stage 1. Foundations

1. Install and configure Storybook in apps/web: docs, a11y with a11y: { test: 'error' } in
   preview, stories as tests (Vitest), MDX tables, scripts. Run story tests in both themes.
2. The tokens already exist in globals.css (SPEC-120). Do not rewrite them. Verify that
   globals.css matches tokeny.md (the #132 sync test does this), load globals.css in
   Storybook and recompute contrast for the values actually stored. If any pair falls below
   its threshold, stop and ask.
3. Fonts: Figtree is already bundled locally (Fontsource). Use the same, no CDN.
4. Theme switcher (rule 8).
5. Foundations pages render the real CSS variables. Wrap previews in MDX in the Unstyled
   block so documentation styles do not override components:
   - colour: roles and a measured contrast table for every tokeny.md pair in both themes;
     colour is never the only carrier of meaning;
   - typography: roles (page title, section, body, label/caption, metric, code) from the
     text-* tokens; running text at most about 65 characters per line;
   - spacing: the relation rule (within a group, between groups, inside a panel, between
     sections) with the space-* tokens from tokeny.md;
   - shape and depth: radius-surface = 0, borders, when a shadow is allowed;
   - motion: current transitions and prefers-reduced-motion behaviour (ask if the
     materials are silent);
   - icons: lucide-react, sizes, when an icon needs a label;
   - layout: 320, 768 and 1440 px, max-w-content, sidebar.
6. The token guard already exists (apps/web/test/design-tokens.test.ts and the ESLint
   design-system rule from #132, both in CI). Extend their scope to the Storybook files
   (stories, MDX, documentation blocks) instead of writing a second script; documentation
   helper blocks that must break a rule get an explicit, commented exception.

# Stage 2. Primitives

Work on the components from the stage 0 plan, in batches of about six. Stop after each
batch. Start with the existing ones (Button, Badge, Card, Input, NativeSelect, Table, Pre).
Add a new component only if the plan approved it.

Before the first batch, list the shape, density and state parameters already in force:
control heights, radii, borders, padding, focus. Give each its source (SPEC-119,
SPEC-120, D1–D10). Ask about anything the materials do not settle.

Every component gets a page with the same structure, no section skipped (if one does not
apply, say why):
1. Purpose. 2. When to use (DirectiveBench situations). 3. When not to use and what to use
instead. 4. Anatomy. 5. Variants and when to choose each. 6. States: default, hover, focus,
pressed, disabled (and how the user learns why), loading, selected, error. 7. Keyboard,
focus order, ARIA, what a screen reader announces, a target of at least 24 × 24 px.
8. Content: labels, length, long text, numbers, a longer language. 9. Responsiveness
320/768/1440. 10. API with types and defaults. 11. Code: minimal and typical DirectiveBench
example. 12. Do and don't, in pairs. 13. Related.

Stories: Playground, every variant and size, a state matrix (hover and focus as a frozen
preview through a data-preview-state attribute in Storybook CSS, documentation only), long
content and a narrow screen, a play function for the main behaviour. Every story passes
a11y with no violations or has a documented exception.

# Stage 3. Product components and patterns

1. Product components: only those already exported from apps/web/components outside ui/
   (for example common.tsx, nav.tsx, artifacts/*). Each with data states: empty, error,
   partial data, a lot of data, long text. Data comes through props, not the database. If a
   component reads data itself and cannot be shown without changing code, put it on "What
   is missing".
2. Patterns as compositions in stories, each state as its own story:
   - form (the app uses native forms and server actions, not an API): the label is always
     visible and the placeholder is an example; the error message next to the field and
     after submit; focus on the first error; entered data is kept; double submit is
     blocked. Submit states (pending, field error, general error, success) are shown
     through props;
   - filtered list (model: /artifacts): result count, active filters visible and easy to
     remove, a separate "no results for these filters" state with a clear action and a
     separate "nothing here yet" state with an add action;
   - detail view: the key information and main action visible without scrolling, a "does
     not exist" state;
   - risky-action confirmation (model: "Register anyway" on /repositories): the object
     named in the question, an easy way out, the action named with a verb;
   - key patterns from the backlog and SPEC-118 (for example a RED/GREEN result labelled
     as mock).
3. No full-screen stories. On "What is missing", record which screens are missing and that
   they need presentational components extracted from app/ (a separate decision and spec).

# Stage 4. Pages that teach

- Start here: the product's character in three sentences (from the brief), five steps to
  build a screen (find the pattern, pick components with "How to choose", use semantic
  tokens, design the data states, check "What to avoid") and a component table: name,
  import, when, when not.
- Components: a catalogue with a small preview, group, one-sentence description and link.
- How to choose: "if… use…" tables with a product example for the pairs that exist or are
  planned. Mark missing components as missing.
- Usage and accessibility: keyboard and focus, forms and messages, colour, motion,
  content, widths, product rules (mock labelling, "planned", no long dashes). Every rule
  with its source.
- Content: tone (ask if the materials are silent), buttons (verb and object), errors (what
  happened and what to do), empty states (why it is empty, next step), date formats (UTC,
  as formatDate does), numbers, scores and durations.
- What to avoid: (1) DirectiveBench anti-patterns from the specs and lessons, (2) the
  generic AI look (gradients, glass, glow, emoji instead of icons, sparkles as the AI
  symbol, three identical cards, everything in pills, card inside a card, shadow as the
  only separator, everything centred), (3) implementation mistakes (a value outside the
  tokens, a variant added on the side, a div instead of a button, a placeholder instead of
  a label, status shown only by colour, a disabled button without an explanation, a toast
  for an error that needs action, a tooltip holding information needed to act). For each
  point: how to spot it in code, why it is a problem, what to use instead.
- What is missing: what is done, what is missing, backlog coverage: item, component or
  screen, state, priority.
- Contributing: when to add a component (the same need in at least two places), when a
  variant, when nothing; the documentation a new component needs; what to check when a
  token changes (tokeny.md, contrast, extendTailwindMerge in lib/utils.ts, the #132 sync
  test); who approves; commands.

Agent file: apps/web/design-system.md with a summary (character, component table with
import, when and when not, semantic tokens, "if… use…", "what to avoid", commands).
Propose the reference in AGENTS.md §7 to the maintainer as a diff; do not add it yourself.

# Stage 5. Verification and report

1. The rule 13 quality gate, plus build-storybook and the story tests in both themes.
2. The token guard: list every value outside the tokens with file and line.
3. a11y violations across all stories.
4. In the browser: 320, 768 and 1440 px, both themes, keyboard, overlays.
5. Prepare the agent test but do not run it: pick one backlog screen that the app does not
   have yet and write its description in the run log. The maintainer runs the test in a new
   session.
6. Count pages, components, stories and interaction tests.
7. Complete the spec (Implementation status only for what was verified), the run log and
   lessons.

Report: what you built, what you verified, what you did not verify, proposals for the
maintainer's decision and the list of gaps. Never describe anything as done unless you
verified it.

# Done when

- Every component in the plan has a page with 13 sections and a state matrix.
- Every pattern has all data states, and the form also its submit states.
- Missing screens and components are on "What is missing" with a reason.
- The token guard finds no value outside the tokens.
- No a11y violations, or each one is documented.
- Both themes work, overlays included.
- The quality gate passes and the PR is open after the maintainer's "dalej".
- An agent built a new screen from the documentation, and every place where it guessed is
  filled in or listed on "What is missing".
