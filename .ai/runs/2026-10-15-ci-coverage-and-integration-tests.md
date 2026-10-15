---
title: CI per pull request, 100% unit coverage, integration tests of management paths
date: 2026-10-15
agent: Claude Code / claude-opus-5-5
trigger: Maintainer request — CI with build, lint, unit and integration tests for every PR; a 100% unit-coverage rule for new features in AGENTS.md; unit tests to 100% of existing code; integration tests of the home page and management paths
status: completed
branch: ci/test-coverage-and-integration
specs: [SPEC-012, SPEC-014]
---

# Run: CI, coverage and integration tests

## Objective

Every pull request runs build, lint, unit tests and browser integration tests; `AGENTS.md`
states that every new feature needs 100% unit-test coverage; existing logic is raised to 100%;
Playwright covers the home page and the management paths. Acceptance: the coverage gate is
enforced by `pnpm test`, all gates pass locally, specs reflect what was verified.

## Decisions (maintainer, 2026-10-15)

- Database: SQLite stays the default; PostgreSQL becomes an optional second backend, tested
  with testcontainers — delivered in a separate change with its own spec and ADR.
- "Admin panel": DirectiveBench has none; integration tests cover the management paths
  (benchmark → run → executions incl. cancellation, artifacts, results, settings).
- Browser tests in CI use Playwright; agent-browser is for agent-driven local QA only.
- 100% coverage scope: all logic (`packages/*/src`, `apps/cli/src`, `apps/web/lib`,
  `apps/web/proxy.ts`); React pages and components are covered by Playwright instead.

## Plan

1. Measure coverage (`@vitest/coverage-v8`), add a shared 100% threshold (`vitest.shared.ts`)
   and per-package configs, plus a Vitest setup for `apps/web` logic.
2. Restructure CI into parallel jobs with a shared setup action.
3. Write the rule into `AGENTS.md` §2 rule 7 and SPEC-012 §3/§8; add the coverage row to SPEC-014 §9.
4. Fan out: one subagent per package for unit tests (disjoint paths, source changes only for
   dead code or testability), one for Playwright; then integrate, review and run every gate.

## Work performed

- Coverage tooling: `@vitest/coverage-v8` 5.0.4 (root dev dependency), `vitest.shared.ts`,
  `vitest.config.ts` in every package, `apps/web/vitest.config.ts` (scope `lib/**`, `proxy.ts`),
  `turbo.json` test outputs.
- CI: `.github/workflows/ci.yml` → jobs `lint`, `unit`, `build`, `e2e`;
  `.github/actions/setup/action.yml`.
- Tests: 95 → 468 Vitest tests at 100% on all four metrics in all seven packages; Playwright
  7 → 17 tests (`home.spec.ts`, `management.spec.ts` replace `smoke.spec.ts`).
- Source changes (behaviour-preserving unless noted): unreachable fallbacks removed in `core`
  (`frontmatter.ts`, `artifacts.ts`, `hash.ts`), `database` (`latestRunsByArtifact` guard,
  `$count` in `getDashboardStats`) and `cli` (`setup.ts` defaults already supplied by the config
  schema); environment-independent comparator in `core/artifact-loader.ts`; `runDisplayStatus`
  moved to `apps/web/lib/run-status.ts` (re-exported); `proxy.ts` `hostname()` without a dead
  fallback; dependency injection in `apps/cli/src/serve.ts` and `runtime.ts` with the two
  remaining magic numbers named (`HEALTH_POLL_INTERVAL_MS`, `HEALTH_REQUEST_TIMEOUT_MS`).
- **Bug fix:** `LocalRunner.start()` undid a `stop()` that arrived during recovery; regression
  test first (failed: job `completed` instead of `pending`), then the fix.
- Docs: `AGENTS.md`, `README.md`, SPEC-012, SPEC-014, stale test references in other specs.

## Verification

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck` (7/7) — pass.
- `pnpm test --force` — 468 tests passed (core 95, database 59, agent-adapters 34,
  benchmark-engine 109, runner 31, cli 74, web 66); every package 100% statements, branches,
  functions and lines.
- `pnpm build --force && pnpm verify:pack` — all steps passed (covers the `serve.ts` refactor
  in the bundled CLI).
- `pnpm test:e2e` — 17/17 passed; the e2e subagent also ran it 3× and `--repeat-each=3` (51/51).
- Subagents ran each package suite 2–6 times without flakes.
- Not verified: the new four-job workflow on GitHub (runs on the PR); required-check settings.

## Problems and deviations

- Agents reported old test runs leaking temp dirs in `/tmp`; `core`, `cli` and
  `benchmark-engine` tests now clean up. Leftovers from earlier runs were not deleted.
- `v8 ignore` comments: none were needed.

## Lessons recorded

- [Keep 100% branch coverage deterministic](../lessons/2026-10-15-deterministic-full-coverage.md)
- [Reset lifecycle flags before the first await](../lessons/2026-10-15-reset-lifecycle-flags-before-await.md)

## Follow-ups

- Optional PostgreSQL backend with testcontainers integration tests (next change: spec + ADR).
- Make `lint`, `unit`, `build`, `e2e` required checks in the GitHub branch protection.
- Minor findings: `runCommand` reports `exitCode: -2` for a missing executable (type suggests
  `null`); unnamed 5000 ms agent grace period in `orchestrator.ts`; FIFO ties within one
  millisecond are ordered by random ID.
