---
title: Design-token migration and design-system guard in CI (SPEC-121)
date: 2026-10-28
agent: Claude Code / claude-opus-5-5
trigger: maintainer request ("robimy 134" → #132 first), issue #132, spec PR #136
status: completed
branch: feat/design-token-migration-and-guard
specs: [SPEC-121, SPEC-120]
---

# Run: design-token migration and design-system guard in CI

Source doc: .ai/specs/2026-10-28-design-token-migration-and-guard.md

## Objective

Implement SPEC-121 (#132): CI guards for design-system use, then migrate raw type and spacing
utilities to the SPEC-120 tokens with no visual change. Acceptance criteria: SPEC-121 §16.

## Plan

Goal: one way to set a text size or gap, enforced in CI, with pixel-identical pages.
Scope: `apps/web/{app,components}`, `apps/web/test/design-tokens.test.ts`,
`eslint.config.mjs`, `apps/web/tokeny.md`, a new `apps/web/design-system-scope.json`.
Non-goals: new token values, colour changes, Storybook (#134), screenshot baselines in CI.
Risks: a spacing migration that changes meaning (mitigated by the pixel comparison); regexes
that are too broad (mitigated by negative test cases).

## Decisions

The maintainer accepted all six autonomous defaults of SPEC-121 (Q1–Q6) on 2026-10-28.

Decisions made during implementation:

- Spacing mapping is by purpose (FR-121-2):
  - columns and grids of cards use `gap-grid`;
  - rows holding controls (forms, page-header actions) use `gap-inline`;
  - icon and label pairs (Badge, Button `xs`/`sm`, the content-tab file tree) use `gap-inline-tight`;
  - stacks inside a card use `space-y-stack`;
  - section gaps on the dashboard use `mt-section`.

  Left raw because no token's purpose matches:
  - badge lists (`gap-1`);
  - label above input (`gap-1`);
  - key-value grids;
  - the nav icon and label pair (`gap-2`, which does not equal the 0.25rem of `gap-inline-tight`);
  - the PageHeader title/actions gap (`gap-4`);
  - the sidebar sections;
  - Markdown list items.
- Markdown headings h3–h6 become `text-body`. That is the only `.875rem` token; the rule bans
  `text-sm` everywhere.
- Arbitrary-value allowlist entries are scoped to a file. A test fails on a stale entry.

## Work performed

1. Shared scope file `apps/web/design-system-scope.json` read by the token test — 646f083.
2. `tokeny.md` "CSS property" column, the missing `--font-heading` row and the sync test —
   b4571e2.
3. Arbitrary-value rule with the class-token reader, unit cases and a file-scoped allowlist —
   6a30444.
4. ESLint `designSystemComponents` block, with the commented Markdown table exception —
   972fe15.
5. `text-xs`/`text-sm` rule and migration (26 files, 164 lines) — b63e890.
6. Spacing migration by purpose (10 files, 28 utilities) — 17ec37c.
7. Decision D11 in `tokeny.md` and the SPEC-120 §19 pointer — df126da.

## Verification

| Check | Result |
|---|---|
| Red first: `tokeny.md` sync, missing in the docs | failed on `font-heading` (a real gap), green after documenting it |
| Red first: sync, missing in the CSS | failed on `spacing-stack` after temporarily deleting it from `globals.css` |
| Red first: arbitrary value | failed on `app/executions/page.tsx:44 p-[13px]` (injected) |
| Red first: ESLint | raw `<button>` and `<input name>` in a page each reported; `<input type="hidden">` not reported; the Markdown `<table>` reported once its disable comment was removed |
| Red first: `text-xs`/`text-sm` | 164 lines reported before the migration |
| Pixel comparison | 40 screenshots, byte-identical: 10 demo pages (`/`, repositories, artifacts and detail, benchmarks and detail, executions, results and detail, settings) at 1440 and 390 px in both themes. Same seeded DB copied to the same path, fixed clock, no masks needed. The "before" set was taken twice to confirm determinism |
| Built CSS | contains `.text-ui`, `.text-body`, `.text-ui/relaxed`, `.gap-grid`, `.gap-inline`, `.gap-inline-tight`, `.space-y-stack`, `.mt-section` |
| `pnpm format:check`, `lint`, `typecheck`, `test`, `build`, `verify:pack` | all exit 0; web 255 tests, 100% coverage |
| `pnpm test:e2e` | 52 passed (including text-contrast, design-system, ui-contrast) |

Not verified visually: the repository registration confirmation and scan-status states, which
the demo data does not reach. Their changed utilities (`space-y-2`, `gap-2`) are equal in
value to the tokens.

## Problems and deviations

- The first "after" run differed on `/settings` only. The page prints the data-directory path,
  and the second server used a different copy path. Re-running from the same path gave
  identical images. This is recorded as a lesson.
- A `pkill -f`/`pgrep -f` pattern matched the agent's own shell and killed it (a known
  lesson); the server was then stopped with a pattern that cannot match the shell.

## Review (om-auto-review-pr --autofix, 2026-10-28)

- Major, fixed: the arbitrary-value reader paired quotes per line, so a JSX string or template
  literal spanning lines, or a class after an apostrophe in JSX text, passed the guard (probe:
  47 of 47 green). It now reads literal nodes with the TypeScript parser; the same probe fails
  with `app/zz-probe.tsx:5 p-[13px]`, `:8 mt-[7px]`, `:9 m-[3px]`. Unit cases added.
- Minor, fixed: the ESLint `files` glob used `*{.ts,.tsx}`, which matches nothing with a single
  extension; it is now one glob per root and extension.
- Nit, fixed: the Markdown table disable comment carries its reason with `--`.

## Lessons recorded

- [Pixel comparisons need the same data-directory path](../lessons/2026-10-28-pixel-comparisons-need-the-same-data-dir.md)

## Follow-ups

- #134 (Storybook design-system documentation) is unblocked; its stage 1.6 extends
  `design-system-scope.json`.
- SPEC-121 §19: move the Markdown table onto `Table`, screenshot baselines in CI, #123.
- The maintainer moves SPEC-121 to `implemented/` after approval.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: guards (red first)

- [x] 1.1 Shared scope file read by the token test — 646f083
- [x] 1.2 tokeny.md CSS property column and sync test — b4571e2
- [x] 1.3 Arbitrary-value rule with allowlist — 6a30444
- [x] 1.4 ESLint raw-element rule with the markdown table exception — 972fe15

### Phase 2: migration

- [x] 2.1 Before screenshots on origin/main — (scratch artefacts, no commit)
- [x] 2.2 text-xs/text-sm rule and type migration — b63e890
- [x] 2.3 Spacing migration by purpose — 17ec37c
- [x] 2.4 Decision D11 in tokeny.md and SPEC-120 pointer — df126da
- [x] 2.5 After screenshots, comparison and full gate — this commit
