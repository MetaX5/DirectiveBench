---
id: SPEC-121
title: Design-token migration and design-system guard in CI
status: draft
created: 2026-10-28
updated: 2026-10-28
category: feature
related: [SPEC-120, SPEC-119, SPEC-014]
---

# SPEC-121 — Design-token migration and design-system guard in CI

## 📝 TLDR

Contributors building web screens see two ways to set the same size: the type and spacing
tokens of [SPEC-120](implemented/2026-10-27-design-tokens.md) and the raw Tailwind utilities
they stand for. Most app code still uses the raw utilities. This spec proposes to move app
code onto the tokens without any visual change. It also proposes CI checks that fail when
code drifts back: raw form and table elements outside `components/ui`, arbitrary Tailwind
values, `text-xs` and `text-sm`, and a `tokeny.md` that no longer matches `globals.css`.
This is SPEC-120 §19 and issue [#132](https://github.com/MetaX5/DirectiveBench/issues/132).
#134 (design-system documentation in Storybook) depends on it.

## Resolved assumptions (autonomous defaults)

| # | Question | Default applied | Rationale |
|---|---|---|---|
| Q1 | Split the migration and the CI guard into two specs? | No. One spec in two phases: guard first, then migration. | The maintainer added the guard to #132 on 2026-10-27. The `text-xs` rule only goes green once the migration lands, and #134 needs both in place. |
| Q2 | Migrate the generated `components/ui` files too? | Yes, for `text-xs`/`text-sm` and for spacing that matches a token's purpose. Recorded as a new `tokeny.md` decision. | PR #130 already moved control heights in those files to tokens. #134 documents these files and needs them migrated. The guard catches regressions from a re-run of the shadcn generator, so the [generator lesson](../lessons/2026-10-23-shadcn-generators-need-a-compatibility-review.md) review stays mechanical. |
| Q3 | Markdown renderer `<table>`: use `Table` or allow an exception? | A commented ESLint exception on that one line. | `Table` adds a wrapper and styles. That would change how imported Markdown renders, while "Done when" asks for pixel-identical screens. Moving it onto `Table` is a separate, visible change. |
| Q4 | Existing arbitrary values: new tokens or exceptions? | Documented exceptions, as an allowlist with reasons in the test. | #132 excludes new token values. The current uses are system colours (`bg-[Canvas]`, `text-[CanvasText]`, decision 12), grid track templates, two scroll-height limits and the inline `card-spacing` component token. None of these is a reusable token today. |
| Q5 | How do the ESLint rule and the test share their file scope (the #134 request)? | One JSON file, `apps/web/design-system-scope.json`, read by both `eslint.config.mjs` and `design-tokens.test.ts`. | JSON loads in both places without a TypeScript loader. It holds data rather than logic, so the coverage gate has nothing to measure. |
| Q6 | How to prove there is no visual change? | Before/after Playwright screenshots of the demo pages in both themes, compared once during the run. Results go in the PR and the run log, with no committed baselines. | This meets the "Done when" item without adding a screenshot-baseline workflow to CI, which would need its own decision. |

## 1. Summary

The web UI moves its remaining raw type and spacing utilities onto the SPEC-120 tokens, with
no visual change. CI then enforces design-system use through one ESLint rule and three new
unit-test rules, all reading one shared file scope.

## 2. Motivation and problem statement

Raw-utility counts on `main` at `9ff1cfb`, listed as `app/` / `components/ui/` / other
`components/` (from #132):

| Utility | Token | Uses |
|---|---|---|
| `text-xs` (incl. `text-xs/relaxed`, `md:text-xs`) | `text-ui` | 101 / 12 / 10 |
| `text-sm` | `text-body` | 29 / 2 / 14 |
| `gap-4` (grids) | `gap-grid` | 3 / 0 / 5 |
| `gap-2` | `gap-inline` | 10 / 0 / 2 |
| `gap-1` | `gap-inline-tight` | 16 / 6 / 3 |
| `space-y-2` | `space-y-stack` | 8 / 0 / 2 |
| `mt-6` between sections | `mt-section` | 2 / 0 / 0 |

With two ways to set the same value, a later change to a token's value misses every screen
that still uses the raw utility. Nothing stops new code from adding raw values, raw
`<button>`/`<table>` elements or arbitrary `[…]` values. `tokeny.md` and `globals.css` can
also drift apart unnoticed. Today `--font-heading` is defined in `globals.css` and missing
from `tokeny.md`.

## 3. Goals

- No `text-xs` or `text-sm` in `apps/web/app` or `apps/web/components`.
- Spacing utilities whose purpose matches a `space-*` token use that token.
- Rendered pages are pixel-identical before and after, in both themes, or each difference is
  explained.
- CI fails on each of the following: a raw form or table element outside `components/ui`, an
  arbitrary Tailwind value that is not on the allowlist, `text-xs`/`text-sm`, and a token
  defined in one of `tokeny.md` and `globals.css` but not the other.
- The guards take their file scope from one place, so #134 can extend it to Storybook files.

## 4. Non-goals

No new token values, no visual redesign, no colour-token changes, no token export for design
tools, no Storybook work (#134) and no screenshot baselines in CI.

## 5. User stories

- As a contributor, I see one way to set a text size or a gap, and CI tells me when I use
  the other.
- As a maintainer, I change a token's value once, and the change reaches every screen.
- As the #134 agent, I extend the guard to Storybook files by editing one scope list.

## 6. Functional requirements

1. FR-121-1: `apps/web/app` and `apps/web/components` MUST NOT contain `text-xs` or `text-sm`
   in any form (variant prefixes such as `md:` and line-height modifiers such as `/relaxed`
   included). The replacements are `text-ui` and `text-body`. `text-ui/relaxed` MUST keep the
   computed line height of `text-xs/relaxed`.
2. FR-121-2: a spacing utility MUST use a `space-*` token where the token's "Use for" column
   in `tokeny.md` matches the purpose (`gap-grid` for card grids, `gap-inline` for a row of
   controls, `gap-inline-tight` for an icon next to a label, `space-y-stack` for a vertical
   stack inside a card, `mt-section`/`mb-section` between sections). Where no token's purpose
   matches, the raw utility stays (for example `gap-4` inside a card).
3. FR-121-3: `apps/web/design-system-scope.json` MUST list the source directories and file
   extensions under the design-system guard, starting with `app` and `components`
   (`.ts`, `.tsx`). Both `eslint.config.mjs` and `test/design-tokens.test.ts` MUST read it.
4. FR-121-4: an ESLint rule (`no-restricted-syntax` on `JSXOpeningElement`) MUST report
   `<button>`, `<select>`, `<textarea>`, `<table>` and every `<input>` without
   `type="hidden"` in scoped files outside `apps/web/components/ui`. The message names the
   component to use instead. An exception MUST be an `eslint-disable-next-line` comment
   with a reason.
5. FR-121-5: `design-tokens.test.ts` MUST fail on any arbitrary Tailwind value in scoped
   files unless it matches an allowlist entry, and each entry records a reason. The check
   reads class tokens, meaning the whitespace-separated words inside quoted or template
   string literals, not raw lines. JS indexing such as `versions[0]` is therefore never
   matched. The variant prefix is everything up to the last `:` outside brackets
   (`has-[…]:`, `group-data-[…]:`, `not-aria-[…]:`, `*:[img…]:`, `[a]:`, `[&…]:`), and it is
   a selector, not a value. The remaining utility is reported when it contains `[` (an
   arbitrary value such as `p-[13px]`, or an arbitrary property such as `[--x:…]`) or `-(`
   (CSS-variable shorthand such as `px-(--card-spacing)`). The initial allowlist covers the
   current uses: `bg-[Canvas]`/`text-[CanvasText]` (native select, decision 12), the
   `grid-cols-[…]`/`grid-rows-[…]` track templates, `max-h-[28rem]`/`max-h-[40rem]` scroll
   limits, and the `card-spacing` component token in `components/ui/card.tsx` (definition
   and `(--card-spacing)` uses). The test has a negative case for JS indexing and one
   positive case per class-token shape.
6. FR-121-6: `design-tokens.test.ts` MUST fail when a custom property in `globals.css` is not
   documented in `tokeny.md`, and when `tokeny.md` documents one that `globals.css` does not
   define. Covered properties: `--palette-*`, the semantic and component properties
   (`:root`/`.dark`), `--text-*`, `--spacing-*`, `--radius*`, `--container-*` and
   `--font-*`. Out of scope: the Tailwind bridge aliases `--color-*` (generated from the
   semantic names), `--*--line-height`/`--*--font-weight` sub-properties and `--page-inline`
   (the source of `--spacing-page-inline`).
7. FR-121-7: to make FR-121-6 mechanical, the `tokeny.md` Tokens table MUST gain a
   "CSS property" column with the exact property names. Brace groups such as
   `--palette-neutral-{50,100}` are allowed, and the test expands them. `scale-radius` lists
   `--radius, --radius-{sm,md,lg,xl,2xl,3xl,4xl}`. The column says `none` for the Tailwind
   built-in scales (`scale-spacing`, `scale-text`). For `card-spacing`, which is defined
   inline in `components/ui/card.tsx` rather than in `globals.css`, it says
   `none (inline in card.tsx)`. The test ignores rows marked `none`.
8. FR-121-8: `tokeny.md` MUST record decision D11, as item 18 of its decisions list, because
   item 11 is already taken by an unnamed decision. D11 states that the generated `components/ui` files use
   the type and spacing tokens, and output from a shadcn generator re-run is migrated before
   merge, which the guard enforces. SPEC-120 decision D7 (`rounded-none` in generated files)
   is unchanged.

## 7. Non-functional requirements

The new checks run inside the existing "Lint" and "Unit tests" CI jobs, with no new job and
no new dependency. Each failure names `file:line` and the rule.

## 8. Domain entities and contracts

`apps/web/design-system-scope.json`:

```json
{ "roots": ["app", "components"], "extensions": [".ts", ".tsx"], "componentLibrary": "components/ui" }
```

Paths are relative to `apps/web`. #134 adds Storybook roots and extensions (for example
`.storybook`, `.mdx`) here.

## 9. Data flow

N/A: static checks on source files and no runtime behaviour.

## 10. API and interface design

No public API change. The ESLint config gains one block for `apps/web/{roots}/**`, ignoring
`components/ui/**`. The test module gains three `describe` blocks: forbidden type utilities
(an extension of the `forbidden` list), arbitrary values with an allowlist, and the
`tokeny.md` sync.

## 11. UI/UX considerations

No visible change is intended. The pixel comparison (Q6) covers `/`, `/repositories`,
`/artifacts`, an artifact detail page, `/benchmarks`, a benchmark detail page, `/executions`,
`/results` and a result detail page, at 1440 px and 390 px, in both themes, all on the demo
database (`directivebench demo`). The before and after runs use the same database file and
a fixed Playwright clock (`page.clock`). Any region that still varies between runs, such as
job state or relative times, is masked, and each mask is listed in the PR.

## 12. Security considerations

None. The change touches only static checks and class names.

## 13. Error handling

A guard failure fails the CI job with `file:line` and the rule name. Nothing happens at
runtime.

## 14. Edge cases

- `text-xs/relaxed` in `components/ui/card.tsx`: the token form must keep the 1.625 line
  height. Verify it with computed styles.
- Class strings split across lines or built with `cn()` and template literals: the test reads
  string and template literal nodes with the TypeScript parser, so a literal that spans lines,
  or follows an apostrophe in JSX text, is still read word by word.
- `<input type="hidden">` in server-action forms stays allowed. A computed `type` that is not
  a literal is reported, and the fix is an explicit exception comment.
- Tailwind arbitrary properties (`[mask-type:luminance]`) and CSS-variable shorthand
  (`px-(--x)`) count as arbitrary values. JS indexing (`versions[0]`) does not, because only
  string literals are read.
- A shadcn generator re-run reintroduces `text-xs`. The guard fails, and the output is
  migrated (D11).

## 15. Testing strategy

- Unit: `test/design-tokens.test.ts` (new rules) and `test/utils.test.ts` (unchanged). Each
  guard is shown red first with an injected violation, and the PR records the output.
- Lint: the ESLint rule is shown red on a raw `<button>` injected into a page.
- E2E: the existing `text-contrast`, `design-system` and `ui-contrast` suites must pass.
- Manual: the Q6 pixel comparison.

## 16. Acceptance criteria

- [x] AC-1: no `text-xs`/`text-sm` remains in scoped files, and the unit test enforces it.
- [x] AC-2: spacing utilities follow FR-121-2. Remaining raw `gap-*`/`space-y-*` uses are
      intentional (no matching purpose).
- [x] AC-3: each guard (raw element, arbitrary value, token missing from `tokeny.md` or from
      `globals.css`, `text-xs`) is shown failing red first, then passing.
- [x] AC-4: both guards read `design-system-scope.json`.
- [x] AC-5: `tokeny.md` has the CSS property column and decision D11, and the sync test passes.
- [x] AC-6: the pixel comparison (same database, fixed clock, listed masks) is identical in
      both themes, or each difference is explained in the PR.
- [x] AC-7: `pnpm lint && pnpm typecheck && pnpm test` (100% coverage), `pnpm build`,
      `pnpm verify:pack` and `pnpm test:e2e` pass.

## 17. Dependencies

SPEC-120 (tokens). There are no new packages. #134 depends on this spec.

## 18. Open questions

None blocking. The defaults are listed under Resolved assumptions.

## 19. Future extensions

- Move the Markdown renderer's `<table>` onto `Table` (Q3), as a visible change.
- Committed screenshot baselines in CI (Q6).
- Extend the scope to Storybook files (#134, stage 1.6).
- Enforce the en and em dash ban (#123).

## 📋 Implementation Plan

### Phase 1: guards (red first)

1. Add `apps/web/design-system-scope.json` and make `design-tokens.test.ts` derive `files`
   from it, with behaviour unchanged.
2. Add the `tokeny.md` "CSS property" column and the missing `--font-heading` entry, then add
   the sync test (FR-121-6, FR-121-7). Show it red by removing one documented property.
3. Add the arbitrary-value rule with its allowlist (FR-121-5). Show it red with `p-[13px]`.
4. Add the ESLint rule (FR-121-4) with the commented exception in
   `components/artifacts/markdown.tsx`. Show it red with a raw `<button>` in a page.

### Phase 2: migration

5. Capture the before screenshots (Q6) on `origin/main`.
6. Add `/\btext-(?:xs|sm)\b/` to `forbidden` (red), then migrate `text-xs`→`text-ui` and
   `text-sm`→`text-body` across `app/`, `components/` and `components/ui/` (green). Check the
   `text-ui/relaxed` computed line height.
7. Migrate spacing utilities by purpose (FR-121-2).
8. Record D11 in `tokeny.md` and add a SPEC-120 §19 pointer to this spec.
9. Capture the after screenshots and compare them. Run the full gate and E2E.

## 20. Implementation status

- **Implemented (verified 2026-10-28, Linux, Node 22, Chromium; run log
  [`2026-10-28-design-token-migration-and-guard`](../runs/2026-10-28-design-token-migration-and-guard.md)):**
  every acceptance criterion. Guards: `apps/web/test/design-tokens.test.ts` (type utilities,
  arbitrary values with allowlist, `tokeny.md` sync) and the `designSystemComponents` block in
  `eslint.config.mjs`, both reading `apps/web/design-system-scope.json`; each shown red first.
  Migration: no `text-xs`/`text-sm` left; spacing tokens by purpose; 40 before/after screenshots
  (10 demo pages, 1440 and 390 px, both themes) byte-identical. Full gate and 52 E2E tests pass.
- **Not verified visually:** states the demo data does not reach (repository registration
  confirmation, scan status). Their changed utilities have values equal to the tokens.
- The spec stays in `.ai/specs/` until the maintainer approves the move to `implemented/`.
