---
title: Label mock-agent scores on the Artifacts list (issue #54)
date: 2026-10-21
agent: Claude Code / claude-opus-5-5
trigger: issue #54 (om-auto-fix-issue, bug route)
status: completed
branch: fix/issue-54-mock-agent-label
specs: [SPEC-101]
---

# Run: Label mock-agent scores on the Artifacts list

## Objective

Issue #54: the Artifacts list showed the latest evaluation score without the "Mock agent" label
required by SPEC-101 FR-101-14 and AGENTS.md. Acceptance criteria: a latest evaluation run with
the mock agent shows a visible "Mock agent" label next to the score; unit and Playwright tests
cover it.

## Plan

1. Find how the list knows the agent: `listArtifacts` already returns
   `latestEvaluation.agentAdapterId` from `benchmark_runs.agent_adapter_id` (unit-tested in
   `packages/database/test/artifacts.test.ts`), so no repository change is needed.
2. Render the shared `MockBadge` (`apps/web/components/common.tsx`) in the Latest score cell when
   `agentAdapterId === 'mock'`, the same check the dashboard, results and artifact detail use.
3. Playwright: assert the badge next to the demo score, and no label on a never-evaluated row.

## Decisions

- The badge sits under the score in the Latest score cell (not in the Status cell), so it is
  "next to the score" as FR-101-14 asks; reversible layout choice.
- The literal `'mock'` check follows the existing pages instead of introducing `MOCK_AGENT_ID`
  in one place only.

## Work performed

- `apps/web/app/artifacts/page.tsx`: `MockBadge` in the Latest score cell (`data-testid="latest-score"`).
- `apps/web/e2e/management.spec.ts`: the demo row's score shows `100%` and the mock label.
- `apps/web/e2e/registry.spec.ts`: a never-evaluated skill shows `—` and no label.
- SPEC-101 §20: implementation status for issue #54.

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — pass, 100% coverage in every
  package (web: 539/539 statements, 442/442 branches).
- `pnpm build && pnpm verify:pack && pnpm test:e2e` — pass, 37/37 Playwright tests.
- Regression proof: with the badge removed from the page and the app rebuilt, the new assertion in
  `management.spec.ts` failed (`element(s) not found`); restored and rebuilt afterwards.
- Real app: built CLI with a temporary data dir, `demo`, then `serve`; `/artifacts` rendered the
  `validate-external-input` row with `100%` and "Mock agent — not an AI evaluation" in the Latest
  score cell.
- Not verified: a non-mock agent run on the list (no real agent adapter runs in tests); the
  branch is a plain equality check.

## Problems and deviations

None.

## Lessons recorded

None (nothing non-obvious).

## Follow-ups

None.
