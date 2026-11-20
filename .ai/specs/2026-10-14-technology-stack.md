---
id: SPEC-004
title: Technology Stack
status: draft
created: 2026-10-14
updated: 2026-11-19
category: foundation
related: [SPEC-003, SPEC-006, SPEC-009, SPEC-010, SPEC-012]
---

# Technology Stack

Architecture context: [SPEC-003](2026-10-14-system-architecture.md). Decisions: [ADR-0002 SQLite with node:sqlite](../decisions/0002-sqlite-with-node-sqlite.md), [ADR-0003 monorepo](../decisions/0003-monorepo-architecture.md), [ADR-0004 CLI distribution](../decisions/0004-native-cli-distribution.md).

Versions below are the **intended major lines** as of 2026-10-14. Exact versions are pinned by `pnpm-lock.yaml`; the lockfile is authoritative.

## 1. Runtime and tooling

| Technology | Version line | Rationale |
|---|---|---|
| Node.js | engines `>=22.16.0`; the full suite runs on Node 24 (locally and in CI); the CI job `oldest-node` runs the package, CLI and web unit tests, `pnpm build` and `pnpm verify:pack` on Node 22.16.0 (issues #263, #265, #266) | Built-in `node:sqlite` avoids native modules; the floor is set by the `node:sqlite` APIs actually used. See §3.1. |
| npm | 11 (bundled with Node 24) | Distribution channel: `npx directivebench`. |
| pnpm via corepack | 12 (root `packageManager: pnpm@12.11.2`) | Workspaces, strict dependency isolation, fast installs. |
| Turborepo | 2.11 | Task graph and caching for `build`, `typecheck`, `test`. A cached result must be invalidated by a change in any workspace package the task's package depends on: `build` and `typecheck` depend on `^build` / `^typecheck`; `test` depends on `transit`, a task no package has a script for, whose `dependsOn: ["^transit"]` puts every workspace dependency's files into the `test` hash without running anything or ordering the packages' tests (issue #281). |
| TypeScript | **6.0** (6.0.3) | Strict mode. TS 7 is **not** used: `typescript-eslint` peer range is `>=4.8.4 <6.1.0`. |
| ESLint | **10** (10.12, flat config) | Plugins: `typescript-eslint`, `@next/eslint-plugin-next` 16.4.1 and `eslint-plugin-react-hooks` 7.1 directly. `eslint-plugin-react` and `eslint-config-next` are **not** used because they do not support ESLint 10. |
| typescript-eslint | 8.71 | Linting of TypeScript sources. |
| Prettier | 3.9 | Formatting. |
| tsup | 9 | Bundles the CLI (`apps/cli`) and inlines internal workspace packages and the pure-JS libraries (`commander`, `drizzle-orm`, `yaml`, `zod`) into `dist/cli.js`; a banner defines `require` via `createRequire(import.meta.url)` because bundled CommonJS dependencies (`yaml`) call `require()`. `removeNodeProtocol: false` is required, otherwise `node:sqlite` is rewritten to the non-existent `sqlite` module ([lesson](../lessons/2026-10-14-bundler-strips-node-protocol.md)). |
| tsx | 4.x | Runs the CLI from source in development (`pnpm dev`). |

## 2. Application libraries

| Area | Technology | Version line | Rationale |
|---|---|---|---|
| Web framework | Next.js (App Router, Turbopack) | 16.4.1 | Server components + server actions + route handlers in one process; `proxy.ts` (replacement for `middleware.ts` in 16) hosts the Host-header allowlist. Served with `next start` from prebuilt output. |
| UI runtime | React | 19.3 | Required by Next.js 16. |
| Styling | Tailwind CSS | 4.3 | CSS-first config, no runtime. |
| Components | shadcn/ui preset `b3Rq8QfWi` (radix-lyra) | source-owned | Generated components in `apps/web/components/ui`, compatibility exports in `primitives.tsx`, Radix Slot for composition; CVA and tailwind-merge. Configuration in `apps/web/components.json`; see [SPEC-119](implemented/2026-10-23-shadcn-design-system.md). |
| Typography | Figtree Variable | locally bundled | `@fontsource-variable/figtree`; no remote fonts or build-time Google Fonts download. Font license (SIL OFL 1.1) ships in `public/fonts/figtree-LICENSE.txt`. |
| Icons | lucide-react | current major | Tree-shakable icon set. |
| Theming | next-themes | 0.4 | Dark/light theme switching. |
| ORM / migrations | Drizzle ORM 0.45 + drizzle-kit 0.31 | 0.45.4 / 0.31 | Typed schema, SQL-first generated migrations, supports SQLite and PostgreSQL dialects (portability). |
| Database driver | built-in `node:sqlite` (`DatabaseSync`) wrapped by Drizzle `sqlite-proxy` | Node built-in | No native compilation on `npx` install; works on all platforms Node supports. |
| Validation | Zod | 4.6 | Single source for config, definition format v1 and API input schemas; JSON Schema export for the benchmark format. |
| CLI parsing | commander | 15 | Mature, small, typed subcommands. |
| YAML | yaml | 2.9 | YAML 1.2 parser for benchmark definitions and frontmatter. |
| Unit / integration tests | Vitest | 5.0 | Fast TS-native runner across packages. |
| E2E tests | Playwright | 1.64 | Browser smoke test against the real `serve` process ([SPEC-012](2026-10-14-testing-strategy.md)); `apps/web/e2e/home.spec.ts` and `apps/web/e2e/management.spec.ts`, 17 tests passing on 2026-10-15. |
| Example fixture tests | `node --test` | Node built-in | Hidden verification tests in examples need no extra dependency in the workspace. |

## 3. Constraints and rationale details

### 3.1 Node version and `node:sqlite`

- `node:sqlite` is usable without `--experimental-sqlite` from Node 22.13.0.
- The database client (`packages/database/src/client.ts`) calls `StatementSync#setReturnArrays`, added in Node 22.16.0 / 24.0.0, because Drizzle `sqlite-proxy` expects rows as arrays. Therefore `engines.node` is **`>=22.16.0`** (as declared in the root `package.json`), not `>=22.13.0`.
- Node 24 runs the full suite. Node 22.16.0 (SQLite 3.49.1) runs the `packages/*`, `apps/cli` and `apps/web` unit tests, `pnpm build` and `pnpm verify:pack` in the CI job `oldest-node` ([SPEC-012 §8](2026-10-14-testing-strategy.md#8-ci-github-actions)). The web unit tests start the unbuilt highlight worker entry with `--experimental-strip-types` there, because Node strips TypeScript types by default only from 22.18 (issue #266). Node versions between 22.16 and 24 are not tested individually.
- On Node 22 (every release up to 22.23.5), `node:sqlite` returns a TEXT value only up to its first U+0000; SQLite stores it whole. nodejs/node#61954 fixed the read in Node 24.16.0 and Node 26 only, and Node 22's `StatementSync` cannot read TEXT as bytes. The floor stays 22.16.0; stored text never holds U+0000 instead ([SPEC-006 §1](2026-10-14-database-schema.md#1-conventions), issue 265).
- The runtime check compares the Node version against 22.16.0 for every command (exit 3); `doctor` additionally feature-detects `node:sqlite` by preparing a statement and calling `setReturnArrays`.
- `node:sqlite` may emit an `ExperimentalWarning` on some Node versions; if so, the CLI suppresses only that specific warning.

### 3.2 Drizzle `sqlite-proxy`

The bootstrap does not rely on a dedicated Drizzle `node:sqlite` driver. `openDatabase()` wraps a `DatabaseSync` connection with Drizzle's `sqlite-proxy` callback `(sql, params, method) → { rows }` (row arrays for `get`/`all`/`values`), sets `busy_timeout = 5000`, `foreign_keys = ON` and `journal_mode = WAL`. Migrations run through `drizzle-orm/sqlite-proxy/migrator` inside one `BEGIN IMMEDIATE` transaction; multi-statement writes use `withTransaction()` (`BEGIN IMMEDIATE … COMMIT`). Because `node:sqlite` is synchronous, code inside `withTransaction` must not await unrelated I/O. Details: [SPEC-006](2026-10-14-database-schema.md).

### 3.3 Next.js packaging

The CLI ships the prebuilt Next.js output in `dist/web` and spawns `next start` as a child process (not a custom server), keeping Next.js upgrades decoupled from CLI code. Internal workspace packages are consumed via `transpilePackages` in web and bundled into the CLI by tsup together with the pure-JS libraries; `next`, `react` and `react-dom` stay runtime dependencies because the prebuilt app is started with `next start`.

## 4. Dependency policy

1. **Prefer the platform.** Use Node built-ins (`node:sqlite`, `node:test`, `node:crypto`, `fs.cp`, `child_process.spawn`) before adding a dependency.
2. **No native addons** in the runtime dependency graph of `directivebench` (must install with `npx` on a clean machine without build tools).
3. **Minimal runtime surface.** Only `apps/cli` is published; its runtime `dependencies` are limited to what cannot be bundled (Next.js runtime and its peers). Everything else is bundled.
4. **Pin and lock.** Exact versions via lockfile; upgrades through PRs that pass typecheck, lint, unit, integration and e2e.
5. **Peer-compatibility gates.** Major upgrades of TypeScript and ESLint wait for `typescript-eslint` (and, if it is adopted again, `eslint-plugin-react`) support (see §1).
6. **License.** Runtime dependencies must be MIT-compatible permissive licenses (MIT, ISC, BSD, Apache-2.0). No copyleft runtime dependencies.
7. **Supply chain.** No `postinstall` scripts in the published package; pnpm 12 `allowBuilds` allowlist and `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`; `pnpm audit` in CI ([SPEC-007](2026-10-14-security-and-privacy.md)).
8. **No telemetry SDKs.** Next.js telemetry is disabled for the spawned server (`NEXT_TELEMETRY_DISABLED=1`).

## Implementation status

- **Implemented (verified on 2026-10-14 and 2026-10-15 by `pnpm lint && pnpm typecheck && pnpm test`, `pnpm build` and `pnpm verify:pack`, Node 24.21, Linux):** the toolchain and libraries of §1–§2 at the listed versions (pnpm workspace `apps/*`, `packages/*`; Turborepo tasks; strict `tsconfig.base.json`; ESLint 10 flat config without `eslint-plugin-react`); `node:sqlite` + Drizzle `sqlite-proxy` client with WAL, `busy_timeout`, foreign keys and transactional migrations (`packages/database/src/client.ts`); `engines.node: ">=22.16.0"` in the root and CLI `package.json`; tsup bundle with `removeNodeProtocol: false`; `next start` child with `NEXT_TELEMETRY_DISABLED=1`.
- **Implemented — dependency policy §4.3 (verified on 2026-10-15 in the packed tarball by `pnpm verify:pack`):** `@directivebench/*`, `commander`, `drizzle-orm`, `yaml` and `zod` are bundled into `dist/cli.js` (with the `createRequire` banner); the published package's runtime `dependencies` are only `next`, `react`, `react-dom`.
- **Implemented (verified by `pnpm test:e2e`, 17/17 passing against the built CLI on 2026-10-15):** Playwright 1.64 end-to-end tests (`apps/web/e2e/home.spec.ts`, `apps/web/e2e/management.spec.ts`).
- **Implemented — CI:** the workflow (`.github/workflows/ci.yml`, Node 24 on `ubuntu-latest`: install, `pnpm audit --prod`, format check, lint, typecheck, test, build, `verify:pack`, Playwright) ran green on PR #1 on 2026-10-14 (before the audit step was added). §4.7 `pnpm audit --prod` is a CI step since 2026-10-15 and was clean when run locally that day; it has not yet run in CI.
- **Implemented — CI on the oldest supported Node (issue #263, verified on 2026-11-17 by the `Oldest supported Node (22.16.0)` job, [run](https://github.com/MetaX5/DirectiveBench/actions/runs/44127456059/job/134195228801)):** Node v22.16.0 with SQLite 3.49.1, `packages/*` tests without coverage (1,932 passed), `pnpm build`, `pnpm verify:pack` (all steps passed). The same job failed on the pre-fix migration `0009` SQL (`no such column: artifacts.type`, 367 database tests).
- **Implemented — Turbo cache keys cover workspace dependencies (issue #281, verified on 2026-11-19, Node 24, Linux, turbo 2.11.11):** after a one-line change in `packages/agent-adapters/src`, `pnpm test` re-ran `agent-adapters`, `benchmark-engine`, `runner`, `web` and `directivebench` and replayed only `core` and `database` (before the fix it replayed all six other packages); a change in `packages/core/src` misses every package, one in `packages/database/src` misses only `database`, `runner`, `web` and `directivebench` (`turbo run test --dry=json`). `typecheck` (`^typecheck`) was already correct.
- **Not implemented / unverified:** the `apps/cli` and `apps/web` unit tests on Node 22 (issues #265, #266); CI on Windows; dependency-direction checks in CI; suppression of the `node:sqlite` experimental warning; JSON Schema export for the benchmark format.
