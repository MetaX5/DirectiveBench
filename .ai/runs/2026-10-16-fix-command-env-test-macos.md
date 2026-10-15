---
title: Make the runCommand environment test pass on macOS
date: 2026-10-16
agent: Claude Code / claude-opus-5-5
trigger: user report — the test failed on a local macOS run while CI was green
status: completed
branch: fix/command-env-test-macos
specs: [SPEC-110, SPEC-007]
---

# Run: Make the runCommand environment test pass on macOS

## Objective

`packages/benchmark-engine/test/commands.test.ts` › "runs in the given working directory with
exactly the given environment" failed locally on macOS (Node 24.21) and passed on CI (Linux).
Acceptance: the test passes on macOS with a long and with a short `PATH`, still fails when the
child inherits the parent environment, and the full quality gate is green.

## Plan

Reproduce, find the cause, fix the test without weakening what it proves, and verify with a
mutation of the code under test.

## Decisions

- The production code is correct; only the test changes. `runCommand` passes `options.env` as the
  child's whole environment, which is the isolation the test protects.
- The child prints variable names, not values, so the output size no longer depends on the
  developer's `PATH`. The real `PATH` is kept so the test runs under realistic conditions.
- OS-injected names are filtered explicitly (`OS_INJECTED_ENV`, macOS only) rather than switching
  to a "contains" check, so an unexpected inherited variable still fails the test.

## Work performed

1. Reproduced with
   `pnpm exec vitest run test/commands.test.ts -t "runs in the given working directory"`.
2. Found two independent causes:
   - with the developer `PATH` (892 characters) the printed environment was 1,045 bytes, above
     the test's `maxOutputBytes: 1024`, so `truncated` was `true`;
   - with a short `PATH` the key check failed on `__CF_USER_TEXT_ENCODING`, which macOS
     (CoreFoundation) adds to every process (confirmed with `env -i … node -e`).
3. Changed the test to print `{ cwd, names, onlyThis }` and to filter `OS_INJECTED_ENV`.
4. Updated the existing lesson on process-testing pitfalls instead of adding a near-duplicate.

## Verification

- Target test, macOS, developer `PATH` (892 characters): 1 passed.
- Target test, macOS, `PATH=/usr/bin:/bin:<node dir>`: 1 passed.
- Mutation: `env: { ...process.env, ...options.env }` in `src/commands.ts` → the test fails;
  the source was restored (`git diff` on `src/` empty).
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: pass.
- `pnpm test`: 469 passed (core 95, database 59, agent-adapters 34, benchmark-engine 110,
  runner 31, cli 74, web 66), 100% coverage thresholds met.
- `pnpm build`: pass. `pnpm verify:pack`: "Packaging verification passed".
- `pnpm test:e2e`: 17 passed (after `pnpm exec playwright install chromium`; the first attempt
  failed all 17 tests because the Playwright browser was not installed).
- Not verified on Windows.

## Problems and deviations

`pnpm` was only available through `corepack pnpm` on the machine; Turborepo spawns `pnpm`
directly, so the gate was run with a small `pnpm` → `corepack pnpm` shim on `PATH`.

## Lessons recorded

- Updated [lessons/2026-10-14-testing-processes-and-http.md](../lessons/2026-10-14-testing-processes-and-http.md)
  and its index entry in [lessons.md](../lessons.md).

## Follow-ups

- CI runs only on `ubuntu-latest`, so macOS-only failures are invisible to it. Consider a macOS
  job (or a scheduled one) for `packages/benchmark-engine`.
- `next dev` generates an untracked `apps/web/AGENTS.md` (Next.js 16 `agentRules`); decide
  whether to disable it or ignore the file.
