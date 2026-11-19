---
title: No en or em dash in app-authored UI copy, enforced by lint (issue 123, phase 2)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #123, maintainer decisions of 2026-11-19 on the phase 1 decision document
status: in-progress
branch: refactor/issue-123-no-dashes-in-ui-copy
specs: [SPEC-116, SPEC-014, SPEC-121]
---

# Run: No en or em dash in app-authored UI copy (issue 123, phase 2)

## Objective

Replace every en dash (U+2013) and em dash (U+2014) in app-authored copy of the web app and the
CLI, add an automatic check that fails on a new one and accepts the approved punctuation, and
prove that imported content, descriptions and agent output keep their dashes. Acceptance
criteria: the issue's "Done when" list and the maintainer decisions D1 to D7 (phase 1 decision
document, section 8: all recommendations accepted, D4 variant (a)).

## Plan

One PR in the seven commits of the decision document: (1) lint-rule test, red first;
(2) `apps/web/lib` formatters and messages; (3) pages and e2e; (4) CLI output and
`verify-pack.mjs`; (5) the ESLint selectors; (6) the regression fixture; (7) SPEC-116,
AGENTS.md, run log and lesson. The audit's `prototype.diff` was the starting point; the tree was
re-scanned first and matched the audit (30 web, 7 CLI literals, 1 `tokeny.ts` exception).

## Decisions

- D1: `MISSING_VALUE = 'n/a'` exported from `apps/web/lib/utils.ts`, used by the four
  formatters and by the pages' generic placeholders (also the run page's existing Model `n/a`).
  `modelLabel` in `lib/run-detail.ts` keeps its own `'n/a'` literal (unchanged, no import added).
- D2 words per context, implemented fully (the prototype used `n/a` for some): `No description`
  (artifact list), `Not run` (Last evaluation), `no` (Required), `not reported` via the existing
  `NOT_REPORTED` (candidate outcome), `None` (empty lists, mock agent Specification).
- D3: readiness line `Subscription: ready. Logged in (claude.ai).` (adapter details are full
  sentences ending in a full stop), run warnings `code: explanation`.
- D4 (a): `Planned: not implemented: settings editor`; items `<item>: not implemented`.
- D5: CLI in scope: `Mock agent: not an AI evaluation.`, `n/a`, `CLI default (unpinned)`,
  `; the result measures a skill that was never used`, `(expected 1 to 65535)`.
- D6/E1: `uiCopySelectors` (Literal and JSXText with characters, escapes via the cooked value,
  and HTML entities; TemplateElement cooked value) spread into the existing
  `designSystemComponents` block and a new non-overlapping `uiCopy` block (components/ui, web
  lib, `apps/cli/src`, `packages/*/src`). One documented disable in `tokeny.ts`.
- `turbo.json`: the test task also depends on `eslint.config.mjs`, so a cached web test run is
  not reused after a config change (the lint test reads that file).
- Spec quotes of the old mock label in other specs (SPEC-001, SPEC-002, SPEC-009, SPEC-012,
  SPEC-101, SPEC-107, SPEC-108, SPEC-111, SPEC-112, SPEC-113) were left alone: documentation is outside the copy rule and
  the decision document scopes spec edits to SPEC-116. Listed as a follow-up.

## Work performed

1. `test(web)`: `apps/web/test/ui-copy-lint.test.ts` (39 tests) and the turbo input. Red on
   main: 26 failed, 13 passed (every "reports" and "checks" case and the design-system case
   failed; the "accepts" and "does not check" cases pass trivially without the rule).
2. `refactor(web)`: lib formatters and messages, unit tests.
3. `refactor(web)`: 9 pages, e2e assertions updated, new e2e checks for Required `yes`/`no`,
   the artifact list's `n/a` and `Not run`, the mock row's `None`, the RED/GREEN subtitles;
   the scan-explanation guard now checks both dashes.
4. `refactor(cli)`: CLI output, tests, `verify-pack.mjs`.
5. `chore(lint)`: the selectors; the lint test turned green. A mutation run (selectors moved to a
   separate block over `apps/web/app`) failed 4 tests including the design-system case.
6. `test(web)`: regression fixture: AGENTS.md with both dashes (rendered, byte-exact raw view,
   stored content, sha256 and content hash), a Cursor rule description with both dashes in the
   Artifacts list, an agent-written line with both dashes on the agent-run files page.
7. `docs`: SPEC-116 FR-116-21 colon form, new FR-116-24, implementation status, acceptance
   criterion wording; AGENTS.md §7 enforcement pointer; this log; the lesson.

## Verification

| Command | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass, 7/7 packages, 100% lines/branches/functions/statements everywhere |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass, 28 checks incl. "demo labels mock results" with the new label |
| `pnpm test:e2e` | 201 passed |
| `pnpm test:storybook` | 68 files, 342 tests passed |

Real app (`sh .ai/scripts/test-env-up.sh`, port 4398, demo data): the served HTML of `/`,
`/artifacts`, the artifact detail (all six tabs), `/benchmarks`, the benchmark detail,
`/executions`, `/results`, the run detail, its compare page and both agent-run files pages,
`/agents`, `/repositories`, `/settings`, `/categories`, `/builder`, `/providers` contains no
U+2013/U+2014 and no dash entity. `directivebench demo` prints
`Mock agent: not an AI evaluation.`; `serve --port 99999` prints
`Invalid port "99999" (expected 1 to 65535)`.

Browser QA agent (headless Chromium, 27 page variants x 2 themes x 1280/320, keyboard, console,
a registered folder with dashes in content and description): no functional problem, no
overflow, zero console errors, zero dashes in visible text and accessible attributes on demo
data; imported dashes kept verbatim in the list, rendered view, raw view, metadata and
versions. Two low-severity wording findings, both maintainer decisions and left unchanged:
`No description` uses the same muted style as a real description (D2), and the double colon in
`Planned: not implemented: ...` (D4 (a), with the wording follow-up the decision names). Its
other findings were pre-existing and unrelated (horizontal table scroll inside cards, no skip
link). No confirmed defect needed a regression test.

Not verified: the `Not conclusive`, `Run in progress` and run-warning lines in a browser (no
such state in demo data; changed literals are covered by the lint rule and code review only);
a real screen reader.

## Problems and deviations

- The agent's file tools decoded `\u2013`/`\u2014` escapes into the real characters (a test
  constant, an `eslint.config.mjs` comment, the lesson); found by grepping the bytes and fixed.
- `git fetch origin main:main` is refused while the main checkout has `main` checked out; the
  Codex review used `--base origin/main` (same commit).

## Lessons recorded

- [2026-11-19-flat-config-replaces-restricted-syntax.md](../lessons/2026-11-19-flat-config-replaces-restricted-syntax.md)

## Follow-ups

- Spec text that quotes the old mock label with an em dash (SPEC-001, SPEC-002, SPEC-009,
  SPEC-012, SPEC-101, SPEC-107, SPEC-108, SPEC-111, SPEC-112, SPEC-113) could be aligned with the
  shipped `Mock agent: not an AI evaluation` label.
- If the maintainer dislikes the double colon, change `/settings` and `/repositories` badges
  together (D4 note).
