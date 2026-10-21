---
title: One shared mock-agent check on every page (issue #69)
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: issue #69 (om-auto-fix-issue, refactor follow-up of PR #67)
status: completed
branch: refactor/issue-69-mock-agent-check
specs: [SPEC-101, SPEC-003]
---

# Run: One shared mock-agent check on every page

## Objective

Issue #69: six pages in `apps/web/app` decided whether to show `MockBadge` with the string
literal `agentAdapterId === 'mock'` (or `execution.agent === 'mock'`). Replace them with one
shared check covered by a unit test at 100%, align SPEC-101 §8.2 (which described a
`mockAgent: boolean` the code never exposed) with the code, and change no behaviour: the existing
Playwright mock-label assertions must still pass.

## Plan

1. Check whether the web app may import `MOCK_AGENT_ID` from `@directivebench/agent-adapters`
   (ESLint `webBoundary`, SPEC-003 §2.1).
2. Add the helper where the rules allow it, with a unit test.
3. Replace the seven checks on the six pages.
4. Update SPEC-101 §8.2 and §20.

## Decisions

- **`MOCK_AGENT_ID` is not importable as a value.** The ESLint allowlist for
  `@directivebench/agent-adapters` in `apps/web` is `CLI_AGENTS`, `MockAgentAdapter` and
  `detectCliAgent` ("detection only", SPEC-003 §2.1); type imports are allowed. So the helper
  `isMockAgent()` lives in `apps/web/lib/mock-agent.ts`, repeats the value `'mock'`, and types it
  as `typeof MOCK_AGENT_ID` through a type-only import. If the adapter id ever changes,
  `pnpm typecheck` fails (checked: `'mock-x'` gives TS2322). This keeps the lint rule and
  SPEC-003 unchanged; widening the allowlist instead would be a boundary change that needs a
  spec edit.
- **SPEC-101 §8.2 follows the code, not the other way round** (the more reversible choice):
  `perSuite[].mockAgent: boolean` became `agentAdapterId: string`, plus a note that the
  implemented projection is `ArtifactListItem.latestEvaluation.agentAdapterId` and that pages
  derive the label through the shared check. No repository or schema change. The spec's
  `updated` field was left alone to avoid a conflict with the parallel #56 edit of SPEC-101.
- The helper accepts `null | undefined` because the Artifacts list and the suite page pass an
  optional value (`e?.agentAdapterId`, `definition?.execution.agent`); the result for those is
  `false`, as with the old `=== 'mock'`.

## Work performed

- `apps/web/lib/mock-agent.ts`: `isMockAgent(agentAdapterId)`.
- `apps/web/test/mock-agent.test.ts`: the mock id, other ids (including case and whitespace
  variants and the empty string), `null` and `undefined`.
- `apps/web/app/page.tsx`, `artifacts/page.tsx`, `artifacts/[id]/page.tsx` (two places),
  `benchmarks/[id]/page.tsx`, `results/page.tsx`, `results/[id]/page.tsx`: use `isMockAgent()`.
- SPEC-101 §8.2 and §20.

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — pass; 100% coverage in every
  package (web: 541/541 statements, 442/442 branches, 80/80 functions, 475/475 lines).
- `pnpm build && pnpm verify:pack` — pass.
- `pnpm test:e2e` — 37/37 passed. Run with `DIRECTIVEBENCH_E2E_PORT=4469`, because another
  agent's e2e server was holding the default port 4399.
- Regression proof: with `isMockAgent()` forced to return `false` and the app rebuilt, 4
  Playwright tests failed on the mock label (`home.spec.ts`, `management.spec.ts`); restored and
  rebuilt afterwards.
- Real app: built CLI with a temporary data dir, `demo`, then `serve --port 4479`; the label
  "Mock agent — not an AI evaluation" was rendered on `/`, `/artifacts`, the artifact detail page
  (Overview and Evaluation history), `/results`, the run detail page and the suite page.
- Not verified: a non-mock agent run in the UI (no real adapter executes yet); that branch is the
  unit-tested equality check.

## Problems and deviations

- The default e2e port 4399 was in use by a parallel agent's run; used the documented
  `DIRECTIVEBENCH_E2E_PORT` override instead of stopping it.

## Lessons recorded

None (no non-obvious bug; the type-only `typeof` import pattern is recorded in the helper's
comment).

## Follow-ups

None.
