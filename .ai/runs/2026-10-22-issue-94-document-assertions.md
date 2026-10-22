---
title: Document assertions (SPEC-118 Phase 1, issue #94)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: om-auto-fix-issue 94 (maintainer request, feature route via om-auto-implement-spec)
status: in-progress
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

- [ ] 1.1 Assertion plugin registry with the four existing types
- [ ] 1.2 `file` target resolution

### Phase 2: Bounded patterns

- [ ] 2.1 Pattern worker helper and `file-contains` on it
- [ ] 2.2 Assertion error turns the agent run into infrastructure-error

### Phase 3: Document assertions

- [ ] 3.1 `markdown-sections`
- [ ] 3.2 `required-phrases`
- [ ] 3.3 `markdown-table-value` and number parsing

### Phase 4: Example and docs

- [ ] 4.1 Specification-only document example suite
- [ ] 4.2 Spec status, run log and quality gate

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
