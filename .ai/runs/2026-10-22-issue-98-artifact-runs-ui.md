---
title: Results per artifact version, baseline, comparability and regressions in the web UI (issue #98)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — `om-auto-fix-issue 98` (E06-S05, SPEC-118 Phase 5)
status: completed
branch: feat/issue-98-artifact-runs-ui
specs: [SPEC-118, SPEC-113, SPEC-111, SPEC-203]
---

# Run: Results per artifact version in the web UI (issue #98)

## Objective

Implement SPEC-118 Phase 5 (§6.6 FR-118-50…53, §11, AC-12 and the regression part of AC-19):
`listArtifactRuns`, the artifact page by version and comparability group with version-regression
highlighting (SPEC-111 FR-111-50…52), and the run detail naming the baseline and showing the agent
profile, warnings, tokens/cost as reported and the document-assertion details of PR #105.
Read-only; Playwright tests on seeded runs, no real agent.

## Plan

1. `listArtifactRuns(db, artifactId)` in `packages/database/src/repositories/runs.ts` (candidate
   and baseline version, suite name and version); `getBenchmarkRunDetail` also returns the
   baseline version. Unit tests.
2. Pure presentation logic in `apps/web/lib/artifact-runs.ts` (grouping by version and
   comparability key, version regression per FR-111-50/51) and `apps/web/lib/run-detail.ts`
   (baseline labels, agent profile, invocation, usage, warnings, assertion details), parsing the
   stored JSON with Zod; 100% unit coverage.
3. Artifact page "Benchmark results by version" replaces the flat evaluation history; run detail
   changes.
4. Playwright spec seeding two versions, A/B and `none` baselines, two comparability groups and a
   version regression; cleanup afterwards.
5. Gate, real app on a non-default port with a seeded temp data dir, review loop, PR.

## Decisions

- Version regression (SPEC-111 FR-111-50/51) is computed for display in `apps/web/lib/artifact-runs.ts`
  rather than as `versionRegression` in `benchmark-engine/scoring`: the engine is being changed by
  parallel work (#100, #110) and the web app may only import its `./scoring` subpath; moving it
  is a follow-up. Same semantics as the engine's verdict (`≤ −minDelta + SCORE_EPSILON`).
- A version without an eligible run in a group is skipped: v3 compares with the previous tested
  version (v1), named on the badge.
- The stored JSON written by the real adapter (`summary.environment.agentProfile`,
  `summary.skillInvocation`, the `agent-metadata` trace event, `usage`) is parsed with Zod in the
  web app following the shapes on the #100 branch; anything unreadable reads as "not reported".
- Runs that did not complete are not grouped; they are listed per version as links with status.
- The artifact tab "Evaluation history" is renamed "Results by version" (section title
  "Benchmark results by version", SPEC-118 §11).

## Work performed

1. `listArtifactRuns` and the baseline version in `getBenchmarkRunDetail` (database), tests.
2. `apps/web/lib/run-detail.ts` and `apps/web/lib/artifact-runs.ts` with unit tests.
3. Artifact page results by version; run detail baseline labels, agent profile, invocation,
   warnings, usage, trace counts and document-assertion details.
4. `apps/web/e2e/results-seed.ts` + `results-by-version.spec.ts` (4 tests); seed removed after.
5. Spec status: SPEC-118 §20 Phase 5, AC-12 and AC-19 checked; SPEC-113 §20; SPEC-111 §20.

## Verification

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: pass.
- `pnpm test`: all packages pass with the 100% thresholds (web 202 tests, database 133).
- `pnpm build`, `pnpm verify:pack`: pass.
- `pnpm test:e2e` (port 4498): 43/43 passed.
- Real app: built CLI from the worktree, `demo` into a scratchpad data dir, the e2e seed applied
  with `node --experimental-strip-types`, `serve --port 4497`; checked the seeded artifact page
  (3 versions, 2 groups, regression highlighted, ambient badge), the A/B run detail and the mock
  demo run (mock label, "reports no agent profile"). The first layout cut the Date column off;
  auth mode and isolation moved into the Agent cell. The maintainer's instance on :4280 was not
  touched.
- Not verified: data written by the real Claude Code adapter (not wired yet).

## Problems and deviations

- `pkill -f` matching the server's command line also killed the shell running it (known lesson
  2026-10-14); the server was stopped by its PID from `ss` instead.

## Lessons recorded

None new; the `pkill -f` pitfall is already in lessons/2026-10-14-testing-processes-and-http.md.

## Follow-ups

- Move `compareVersions` into `benchmark-engine/scoring` as `versionRegression` and list version
  regressions in the dashboard's "recent regressions" (FR-111-52, FR-116-12).
- Re-check the parsed shapes once #100 merges and the adapter writes real runs (AC-22 live check).
