---
id: SPEC-004
title: Technology Stack
status: draft
created: 2026-10-14
updated: 2026-10-14
category: foundation
related: [SPEC-003, SPEC-006, SPEC-009, SPEC-010, SPEC-012]
---

# Technology Stack

Architecture context: [SPEC-003](./system-architecture.md). Decisions: [ADR-0002 SQLite with node:sqlite](../../decisions/0002-sqlite-with-node-sqlite.md), [ADR-0003 monorepo](../../decisions/0003-monorepo-architecture.md), [ADR-0004 CLI distribution](../../decisions/0004-native-cli-distribution.md).

Versions below are the **intended major lines** as of 2026-10-14. Exact versions are pinned by `pnpm-lock.yaml`; the lockfile is authoritative.

## 1. Runtime and tooling

| Technology | Version line | Rationale |
|---|---|---|
| Node.js | engines `>=22.16.0`; CI on Node 24 LTS (24.21 verified locally) | Built-in `node:sqlite` avoids native modules; the floor is set by the `node:sqlite` APIs actually used. See §3.1. |
| npm | 11 (bundled with Node 24) | Distribution channel: `npx directivebench`. |
| pnpm via corepack | pinned in root `packageManager` (currently 12.x) | Workspaces, strict dependency isolation, fast installs. |
| Turborepo | 2.x | Task graph and caching for `build`, `typecheck`, `test`. |
| TypeScript | **6.0** | Strict mode. TS 7 is **not** used: `typescript-eslint` peer range is `>=4.8.4 <6.1.0`. |
| ESLint | **9** (flat config) | ESLint 10 is **not** used: `eslint-plugin-react` peer range ends at `^9.7`. |
| typescript-eslint | 8.x | Type-aware linting. |
| Prettier | 3.x | Formatting. |
| tsup | current major | Bundles the CLI (`apps/cli`) and inlines internal workspace packages into `dist/cli.js`. |

## 2. Application libraries

| Area | Technology | Version line | Rationale |
|---|---|---|---|
| Web framework | Next.js (App Router) | 16.x | Server components + server actions + route handlers in one process; `proxy.ts` (replacement for `middleware.ts` in 16) hosts the Host-header allowlist. Served with `next start` from prebuilt output. |
| UI runtime | React | 19.x | Required by Next.js 16. |
| Styling | Tailwind CSS | 4.x | CSS-first config, no runtime. |
| Components | shadcn/ui | copy-in (no version) | Source-owned accessible components on Radix primitives; no component-library lock-in. |
| Icons | lucide-react | current major | Tree-shakable icon set used by shadcn/ui. |
| ORM / migrations | Drizzle ORM 0.45 + drizzle-kit 0.31 | 0.45 / 0.31 | Typed schema, SQL-first generated migrations, supports SQLite and PostgreSQL dialects (portability). |
| Database driver | built-in `node:sqlite` (`DatabaseSync`) wrapped by Drizzle `sqlite-proxy` | Node built-in | No native compilation on `npx` install; works on all platforms Node supports. |
| Validation | Zod | 4.x | Single source for config, definition format v1 and API input schemas; JSON Schema export for the benchmark format. |
| CLI parsing | commander | current major | Mature, small, typed subcommands. |
| YAML | yaml | 2.x | YAML 1.2 parser for benchmark definitions and frontmatter. |
| Unit / integration tests | Vitest | 5.x | Fast TS-native runner across packages. |
| E2E tests | Playwright | 1.x | Browser tests against the real `serve` process ([SPEC-012](./testing-strategy.md)). |
| Example fixture tests | `node --test` | Node built-in | Hidden verification tests in examples need no extra dependency in the workspace. |

## 3. Constraints and rationale details

### 3.1 Node version and `node:sqlite`

- `node:sqlite` is usable without `--experimental-sqlite` from Node 22.13.0.
- The database client (`packages/database/src/client.ts`) calls `StatementSync#setReturnArrays`, added in Node 22.16.0 / 24.0.0, because Drizzle `sqlite-proxy` expects rows as arrays. Therefore `engines.node` is **`>=22.16.0`** (as declared in the root `package.json`), not `>=22.13.0`.
- **CI verifies Node 24 only.** Node 22.16+ support is declared but untested — Assumption — requires validation.
- The runtime check in `doctor`/`serve` must feature-detect the `node:sqlite` APIs actually used (e.g. `typeof StatementSync.prototype.setReturnArrays === 'function'`), not only compare version strings.
- `node:sqlite` may emit an `ExperimentalWarning` on some Node versions; if so, the CLI suppresses only that specific warning.

### 3.2 Drizzle `sqlite-proxy`

The bootstrap does not rely on a dedicated Drizzle `node:sqlite` driver. `openDatabase()` wraps a `DatabaseSync` connection with Drizzle's `sqlite-proxy` callback `(sql, params, method) → { rows }` (row arrays for `get`/`all`/`values`), sets `busy_timeout = 5000`, `foreign_keys = ON` and `journal_mode = WAL`. Migrations run through `drizzle-orm/sqlite-proxy/migrator` inside one `BEGIN IMMEDIATE` transaction; multi-statement writes use `withTransaction()` (`BEGIN IMMEDIATE … COMMIT`). Because `node:sqlite` is synchronous, code inside `withTransaction` must not await unrelated I/O. Details: [SPEC-006](./database-schema.md).

### 3.3 Next.js packaging

The CLI ships the prebuilt Next.js output in `dist/web` and spawns `next start` as a child process (not a custom server), keeping Next.js upgrades decoupled from CLI code. Internal workspace packages are consumed via `transpilePackages` in web and bundled into the CLI by tsup.

## 4. Dependency policy

1. **Prefer the platform.** Use Node built-ins (`node:sqlite`, `node:test`, `node:crypto`, `fs.cp`, `child_process.spawn`) before adding a dependency.
2. **No native addons** in the runtime dependency graph of `directivebench` (must install with `npx` on a clean machine without build tools).
3. **Minimal runtime surface.** Only `apps/cli` is published; its runtime `dependencies` are limited to what cannot be bundled (Next.js runtime and its peers). Everything else is bundled.
4. **Pin and lock.** Exact versions via lockfile; upgrades through PRs that pass typecheck, lint, unit, integration and e2e.
5. **Peer-compatibility gates.** Major upgrades of TypeScript and ESLint wait for `typescript-eslint` and `eslint-plugin-react` support (see §1).
6. **License.** Runtime dependencies must be MIT-compatible permissive licenses (MIT, ISC, BSD, Apache-2.0). No copyleft runtime dependencies.
7. **Supply chain.** No `postinstall` scripts in the published package; pnpm `onlyBuiltDependencies` allowlist; `pnpm audit` in CI ([SPEC-007](./security-and-privacy.md)).
8. **No telemetry SDKs.** Next.js telemetry is disabled for the spawned server (`NEXT_TELEMETRY_DISABLED=1`).

## Implementation status

- **Implemented in bootstrap (observed in repo on 2026-10-14):** pnpm workspace (`apps/*`, `packages/*`), Turborepo task config, strict `tsconfig.base.json`, root scripts for build/typecheck/lint/test/e2e. Remaining stack items are being implemented concurrently — verify against package manifests and lockfile.
- **Implemented (verified in code):** `node:sqlite` + Drizzle `sqlite-proxy` client with WAL, `busy_timeout`, foreign keys, transactional migrations (`packages/database/src/client.ts`); root `engines.node: ">=22.16.0"`.
- **Not implemented / unverified:** CI on Node 22; Windows/macOS verification; `pnpm audit` and dependency-direction checks in CI; suppression of the `node:sqlite` experimental warning; `NEXT_TELEMETRY_DISABLED` in the spawned server.
