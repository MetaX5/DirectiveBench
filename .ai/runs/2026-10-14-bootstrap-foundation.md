---
title: Bootstrap the DirectiveBench foundation
date: 2026-10-14
agent: Claude Code / claude-opus-5-5 (with parallel subagents for specifications)
trigger: Maintainer request — complete project bootstrap and technical specification prompt, followed by requests to adopt the .ai specs/runs/lessons structure, commit via gh and add Claude Code working practices to AGENTS.md
status: completed
branch: feat/bootstrap-foundation
specs: [SPEC-001, SPEC-003, SPEC-006, SPEC-009, SPEC-012, SPEC-013, SPEC-107, SPEC-108, SPEC-110, SPEC-111, SPEC-112, SPEC-114]
---

# Run: Bootstrap the DirectiveBench foundation

## Objective

Design and bootstrap DirectiveBench: specifications and ADRs, a pnpm/Turborepo monorepo, a CLI
designed for `npx directivebench`, a Next.js UI, SQLite persistence, and one verified vertical
slice — import a sample artifact and benchmark, run baseline and candidate with a deterministic
mock agent, evaluate real assertions, persist results and show them in the UI. No publishing,
deployment or paid API calls.

## Plan

1. Inspect the repository and toolchain (only `LICENSE` existed; Node 24.21; pnpm 12 installed
   by the maintainer during the run).
2. Write an architecture brief; delegate specification and ADR writing to parallel subagents.
3. Build packages bottom-up with tests: core → database → agent-adapters → benchmark-engine →
   runner; then the web UI and CLI.
4. Verify end to end from source, then from the packed tarball; add Playwright smoke tests and CI.
5. Restructure `.ai/` per the maintainer's request, reconcile specs with the code, open a PR.

## Decisions

- **SQLite driver:** built-in `node:sqlite` wrapped with Drizzle `sqlite-proxy` (Drizzle 0.45 has
  no `node:sqlite` driver; avoids native addons for `npx` users). Requires Node >= 22.16. ADR-0002.
- **Packaging:** ship the Next.js build output and start it with `next start` from the CLI
  (`next`/`react` as runtime dependencies) instead of standalone output, because npm tarballs
  cannot carry nested `node_modules`. ADR-0004.
- **Packages:** `model-providers`, `git-providers`, `shared`, `config` and `apps/runner` were not
  created (no meaningful code yet); the runner is `packages/runner`, run inside the CLI. ADR-0003.
- **Toolchain:** TypeScript 6.0 (typescript-eslint limit), ESLint 10 without
  `eslint-plugin-react` (no ESLint 10 support).
- **Mock agent:** follows a per-case playbook whose steps are guarded by phrases that must appear
  in installed instructions; outputs are judged by real assertions (`node --test`). Labelled
  "Mock agent — not an AI evaluation" everywhere.
- **Execution safety:** `local-process` is not a sandbox; commands run only for suite versions
  approved for execution (bundled example only), argv-only, env allowlist, per-run HOME.
- **`.ai` structure:** specs renamed to `YYYY-MM-DD-slug.md` with `implemented/` and `archive/`;
  proposals became draft specs; templates moved to `.ai/templates/`.

## Work performed

Commits on `feat/bootstrap-foundation`:

- `chore`: monorepo tooling (pnpm, Turborepo, TypeScript, ESLint, Prettier, Vitest)
- `feat(core)`, `feat(database)`, `feat(agent-adapters)`, `feat(benchmark-engine)` (+ examples),
  `feat(runner)`, `feat(web)`, `feat(cli)`
- `docs`: specifications (41) and ADRs (10), later restructured (`docs(ai)`)
- `build(cli)`: dist assembly and `scripts/verify-pack.mjs`
- `chore`: om-* agent skills installed by the maintainer
- `docs(agents)`: Claude Code working practices in AGENTS.md
- `test(web)`: Playwright smoke tests; `ci`: GitHub Actions workflow and templates;
  `docs`: README, CONTRIBUTING, SECURITY; `docs(specs)`: reconciliation with the implementation

## Verification

All commands were run locally on Linux, Node 24.21.0, pnpm 12.11.2:

- `pnpm lint` — pass; `pnpm format:check` — pass; `pnpm typecheck` — 7/7 packages pass.
- `pnpm test` — 81 tests pass (core 36, agent-adapters 8, database 7, benchmark-engine 21,
  runner 4, cli 5), including a full RED/GREEN run of the bundled example and migrations on a
  fresh database.
- `directivebench demo` (from source and from the installed tarball) — baseline 50.0 %,
  candidate 100.0 %, delta +50 points, verdict `improved`, confidence `medium`.
- `pnpm build && pnpm verify:pack` — pass: tarball contents (no `.env`, no source maps, no
  build-machine paths), install into an empty project, `--help`, `--version`, `demo`, `serve`,
  `/api/health`, run visible in `/results`, foreign `Host` header rejected (403), clean exit on
  SIGTERM.
- `pnpm test:e2e` — 6/6 Playwright tests pass (including a run started from the UI and completed
  by the runner).
- `directivebench doctor` detected Claude Code 2.1.296, codex-cli 0.162.1 and Cursor Agent
  locally (detection only).

Not verified: Node 22.x (only 24.21 was available), macOS and Windows, the GitHub Actions
workflow itself (it has not run yet), `npx directivebench` from the npm registry (not published).

## Problems and deviations

- Artifact install path check let `../` escape the install directory (inside the workspace) —
  caught by a unit test, fixed by validating against the install root.
- tsup stripped `node:` prefixes (`node:sqlite` → `sqlite`), breaking only the packed CLI —
  caught by `verify:pack`, fixed with `removeNodeProtocol: false`.
- Next.js emitted server source maps with absolute paths — excluded from the package.
- Commander parsed `--port` on the program instead of `serve` — option merging added.
- A WordPress example argv element containing commas was split by YAML flow syntax — quoted.
- The `tests/` directory from the prompt was not created: cross-package integration tests live in
  `packages/runner/test`, UI smoke tests in `apps/web/e2e`, packaging checks in `scripts/`.

## Lessons recorded

- [Run `pnpm verify:pack` after any bundling change](../lessons/2026-10-14-bundler-strips-node-protocol.md)
- [Validate untrusted paths against the narrowest root](../lessons/2026-10-14-validate-paths-against-the-real-root.md)
- [Toolchain constraints](../lessons/2026-10-14-toolchain-version-constraints.md)
- [Process and HTTP testing pitfalls](../lessons/2026-10-14-testing-processes-and-http.md)

## Follow-ups

- Maintainer review of all draft specs and the ADRs marked Proposed (0008, 0009).
- The om-* skills come from `open-mercato/skills`; confirm their license allows redistribution
  in this MIT repository.
- Recommended next task: Milestone 1, first slice — register a local directory/Git repository,
  scan it with the existing artifact parsers, create versions and show them in the registry.
- Real agent adapters (Milestone 4) need answers to the open questions on HOME isolation vs.
  subscription login recorded in the integration specs.
