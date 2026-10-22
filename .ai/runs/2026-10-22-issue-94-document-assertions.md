---
title: Document assertions (SPEC-118 Phase 1, issue #94)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: om-auto-fix-issue 94 (maintainer request, feature route via om-auto-implement-spec)
status: completed
branch: feat/issue-94-document-assertions
specs: [SPEC-118, SPEC-107, SPEC-108]
---

# Run: Document assertions (SPEC-118 Phase 1, issue #94)

Source doc: .ai/specs/2026-10-22-benchmark-own-skills-s1.md
Engine: om-auto-create-pr (steps: 9, --loop: no)

## Objective

Implement Phase 1 of SPEC-118 (issue #94, E06-S01): an assertion plugin registry with the four
existing types (no behaviour change), `file` target resolution (path or glob over agent-changed
files), bounded evaluation of user regular expressions in a worker (`file-contains` moved onto
it), the `markdown-sections`, `required-phrases` and `markdown-table-value` assertion types with
number parsing, and a specification-only document example suite. Acceptance criteria: the
issue's Given/When/Then list (AC-6, AC-13, AC-24; FR-118-40…46; NFR-118-02).

Non-goals: Phase 2+ of SPEC-118 (A/B baseline, migration, adapter, CLI, UI) — #95 is implemented
in parallel and owns `RunBenchmarkInput`, scoring and the comparability key; LLM-judge; heading
levels, "any of" phrases, other row-key columns; RE2 or any new dependency.

## Plan

Goal: grade documents deterministically and bound every user regex, inside
`packages/benchmark-engine` only.

- `definition.ts`: shared regex/flags helpers (unchanged messages for `file-contains`), a
  `TextMatcher` schema, the three new schemas in the discriminated union, a per-type traits table
  (`deterministic`, `executesCommands`) used by `isDeterministicAssertion` and
  `definitionRunsCommands`. `definition.ts` stays free of evaluator imports because the web app
  imports `@directivebench/benchmark-engine/definition`.
- `assertions.ts`: `AssertionPlugin` contract and a typed registry (one entry per type,
  exhaustiveness checked by the type system); `evaluateAssertion` dispatches through it and still
  never throws. `AssertionResult.error?` for evaluations that could not finish.
- `assertion-target.ts`: `file` → one workspace file (plain path via `resolveInside`; glob over
  added/modified `changedFiles`, exactly one match).
- `pattern-worker.ts`: one `node:worker_threads` worker per assertion evaluation (inline source,
  so it works from TypeScript sources, the tsup bundle and the packed CLI alike), deadline
  `ASSERTION_REGEX_TIMEOUT_MS` = 2 000 ms, terminate on deadline or abort.
- `markdown.ts`: linear line scans for fenced code, ATX/setext headings, GFM tables, literal
  phrase search with whitespace folding, and number parsing (FR-118-44).
- `orchestrator.ts`: an assertion error turns the agent run into `infrastructure-error` with
  error `assertion-error: …` and keeps its assertion results (details carry `error`), and an abort
  during the last assertion yields `cancelled`. Kept to the assertion loop to avoid conflicts with
  #95.
- `examples/benchmarks/document-assertions/`: specification-only suite using the §8.4 reference
  scenario plus fixture documents used by tests.
- Spec updates: SPEC-118 §20, SPEC-107 §8.3 table and §20, SPEC-108 assertion table/status.

Risks: worker timing tests on loaded CI (use the real 2 s deadline with wide margins, run the
adversarial cases concurrently, ratio-based linearity checks); coverage of the inline worker
source (a string, not instrumented — behaviour is tested end to end).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Registry and targets

- [x] 1.1 Assertion plugin registry with the four existing types — ae59f03
- [x] 1.2 `file` target resolution — ae59f03

### Phase 2: Bounded patterns

- [x] 2.1 Pattern worker helper and `file-contains` on it — ae59f03
- [x] 2.2 Assertion error turns the agent run into infrastructure-error — ae59f03

### Phase 3: Document assertions

- [x] 3.1 `markdown-sections` — ae59f03
- [x] 3.2 `required-phrases` — ae59f03
- [x] 3.3 `markdown-table-value` and number parsing — ae59f03

### Phase 4: Example and docs

- [x] 4.1 Specification-only document example suite — 9618119
- [x] 4.2 Spec status, run log and quality gate

## Decisions

- **One commit for the engine code.** Registry, targets, worker and the three types share
  `definition.ts`/`assertions.ts`; splitting them would have produced intermediate commits that
  do not build. The Progress steps all point at the same commit.
- **Traits table in `definition.ts`, evaluators in a registry in `assertions.ts`.** The web app
  imports `@directivebench/benchmark-engine/definition`; keeping `deterministic` and
  `executesCommands` there (`ASSERTION_TYPE_TRAITS`) lets `definitionRunsCommands` and
  `isDeterministicAssertion` use them without loading worker or command code. The plugin
  interface has no `schema` or `requiredCapabilities` field because nothing would read them yet
  (SPEC-107 §8.3 updated to match).
- **Inline worker source (`eval: true`).** No separate worker entry to bundle or copy; verified in
  the packed CLI (`verify:pack`, manual demo).
- **No worker for literal-only evaluations.** Literals (headings, phrases, column header) are
  matched on the runner thread by linear scans, so `matchPatterns([])` returns at once.
- **Agent-written table text is redacted, then cut to 200 characters** (`MAX_EXCERPT_CHARS`) in
  messages and details (FR-107-16); details never carry whole documents.
- **`caseSensitive` of `required-phrases` applies to literals only**; patterns use their own
  flags, and run on the raw text (a line break inside a phrase needs `\s+`).
- **Thematic breaks** (`---` with no paragraph above) are neither headings nor text; `---` with a
  pipe is a table delimiter, without one a setext underline.
- **Glob detection**: a `file` containing `*`, `?` or `[` is a glob; dotfiles are not matched by
  `**` (`node:path` `matchesGlob`).
- **An abort during the last assertion is `cancelled`**, checked after the loop, so a worker
  terminated by cancellation never reads as an assertion error.
- **Runner integration test added** (`packages/runner/test/document-assertions.test.ts`, new file)
  to prove the §8.1 persistence contract through SQLite; no runner source changed.

- **Review round 1 refinements (FR-118-41/44 details not fixed by the spec):** headings inside
  block quotes and list items count, their other lines (lazy continuation), indented code and
  HTML comments never become setext content; a minus is a sign only at the start or after
  whitespace or `(` (`PM-5` → 5), `.5` → 0.5, and a non-finite number is no number.

## Work performed

1. Run log / execution plan, draft PR #105 — dab5b0a.
2. Engine: `assertion-support.ts` (result helpers, target resolution, bounded reads),
   `pattern-worker.ts`, `markdown.ts`, `document-assertions.ts`, registry in `assertions.ts`,
   schemas and traits in `definition.ts`, assertion-error handling in `orchestrator.ts`; tests
   `pattern-worker`, `markdown`, `document-assertions`, `definition`, `orchestrator` — ae59f03.
3. Example `examples/benchmarks/document-assertions/` — 9618119.
4. SPEC-118 §20 and AC-6/AC-24, SPEC-107 §8.3/§20, SPEC-108 FR-108-10/§8.1/§19/§20, lesson,
   runner integration test, this log.

5. Review (independent subagent, read-only, three rounds):
   - Round 1 at 13e799d — request changes: 1 major (worker construction could reject → scored
     fail instead of assertion error), 4 minor (literal boolean argument, setext false positives
     in quotes/lists/indented code/HTML comments, number-parsing edge cases, run-log status),
     nits. Fixed in 5f424f1 (glob list cap, shared `literalSearch`, traits-based `deterministic`,
     cast comment included).
   - Round 2 — 1 minor regression (list-item handling hid GFM tables). Fixed in f337ec9.
   - Round 3 — approve; nit (container flag not reset at an ATX heading or fence) fixed in the
     following commit. Deferred nits: worker `exit` without message (covered by the deadline),
     `resourceLimits`, a row-count cap, a structured error code (Phase 3), cancellation-test
     timing, tables inside block quotes (not detected).
6. Codex adversarial review (needs-attention, triaged valid by the coordinator), fixed:
   - [high] each pattern carried its own copy of the texts, so structured cloning copied the
     document per pattern (120 × 2 MiB ≈ 332 MiB RSS) with no cap. Now `PatternRequest` sends
     the texts once (`workerPayload`), with named limits `MAX_MATCHERS_PER_ASSERTION` (100) and
     `MAX_PATTERN_LENGTH` (1 000) in the schema and `MAX_PATTERN_INPUT_CHARS` (4 Mi) checked
     before a worker is constructed (fails closed as `pattern-worker-failed`).
   - [medium] fences inside block quotes and list items did not hide their headings; fences now
     open and close on container content.
   - [medium] a table body did not end at a list item or thematic break; it now ends at every
     GFM block boundary checked (blank line, ATX heading, fence, block quote, list item,
     thematic break).
   Gate after the fixes: 1 081 tests (engine 227), 100% coverage, build and verify:pack pass.
   CI then failed once on `scans setext paragraphs in linear time` (ratio 10.6 vs bound 10).
   Measured at four sizes, the scanner and plain `split`/`replace` scale the same way: per-unit
   cost doubles once strings outgrow the caches. The test now forces a GC before each timed run
   and divides the scan's 8× growth by a linear baseline's (idle ≤ 1.5, loaded ≤ 1.5, a quadratic
   probe 6.3, bound 4). The timing lesson is updated.
7. Merged origin/main (PR #106, Phase 2): conflicts only in SPEC-118 §20 (both phases kept) and
   the lessons index; `orchestrator.ts` merged cleanly with baseline install and the
   assertion-error handling. Gate after the merge: 1 126 tests, 100% coverage, build and
   verify:pack pass. CI then failed the 2 MiB timing test (1 166 ms against 1 s). The bound is
   now 5 s; the < 200 ms target stays a local measurement.

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check` | pass |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass — engine 217 after review fixes (196 before), runner 225, core 247, database 120, web 153, cli 75, adapters 34); 100% statements/branches/functions/lines in every package |
| `pnpm build && pnpm verify:pack` | pass — tarball installs, demo "improved", serve smoke checks |
| runner `test/document-assertions.test.ts` | 2 passed |

- **Red first:** the adversarial `(.*a){20}` test failed with `ok: true` until its input was
  armed (see the lesson); the excerpt test failed on an off-by-one in the expectation, not code.
- **Real run:** the packed CLI's `directivebench demo` in a fresh data directory gave baseline
  50 %, candidate 100 %, verdict improved (same as `main`); the stored `file-contains` rows
  ("/\bRangeError\b/ matched in src/parse-age.js") came from the worker inside the bundle.
- **NFR-118-02:** a 2 MiB document (headings, prose, tables) took, fastest of three, 64 ms
  (`markdown-sections`), 88 ms (`required-phrases`), 65 ms (`markdown-table-value`) and 26 ms
  (`file-contains`) without coverage; 106–112 ms with coverage instrumentation. CI asserts < 5 s (1 s first; it measured 1.2 s on a loaded 2-core runner after the merge of main)
  plus size-ratio linearity (4× input < 10× time) for eight input shapes.
- **Timer responsiveness:** a 50 ms interval kept firing (≥ 5 ticks, ~40 observed) while
  `(a+)+$` ran; abort terminated the worker within ~100 ms of the signal.
- **Not verified:** behaviour with a real agent (Phases 3–4); the UI rendering of the new
  assertion details (Phase 5 — the web app shows `details` generically today, not checked);
  timing on macOS.

## Problems and deviations

- NFR-118-02's 200 ms bound is verified by measurement on the development machine only; the CI
  test uses 1 s to stay robust on loaded runners (lesson 2026-10-21 on timing tests).
- The spec's adversarial input "`(.*a){20}` on a long line" needed a concrete failing line;
  `('x'.repeat(100) + 'a').repeat(19)` is used.
- The worker body is an inline string and is not instrumented by coverage; it is covered by
  behaviour tests (matches equal to main-thread results, timeout, crash, abort) instead.

## Lessons recorded

- [2026-10-22 — Prove an adversarial regex input backtracks before testing a bound with it](../lessons/2026-10-22-prove-adversarial-regex-inputs-backtrack.md)

## Follow-ups

- Phase 5 (#98): render the new assertion details (found/missing headings, table cell and value,
  assertion errors) on the run detail page.
- Phase 2 (#95) is in flight in parallel; this change does not touch `RunBenchmarkInput`,
  scoring or the comparability key.
