---
id: SPEC-004
title: Technology Stack
status: draft
created: 2026-10-14
updated: 2026-10-15
category: foundation
related: [SPEC-003, SPEC-006, SPEC-009, SPEC-010, SPEC-012]
---

# Technology Stack

Architecture context: [SPEC-003](2026-10-14-system-architecture.md). Decisions: [ADR-0002 SQLite with node:sqlite](../decisions/0002-sqlite-with-node-sqlite.md), [ADR-0003 monorepo](../decisions/0003-monorepo-architecture.md), [ADR-0004 CLI distribution](../decisions/0004-native-cli-distribution.md).

Versions below are the **intended major lines** as of 2026-10-14. Exact versions are pinned by `pnpm-lock.yaml`; the lockfile is authoritative.

## 1. Runtime and tooling

| Technology | Version line | Rationale |
|---|---|---|
| Node.js | engines `>=22.16.0`; verified on Node 24.21 only (locally; CI workflow targets Node 24) | Built-in `node:sqlite` avoids native modules; the floor is set by the `node:sqlite` APIs actually used. See §3.1. |
| npm | 11 (bundled with Node 24) | Distribution channel: `npx directivebench`. |
| pnpm via corepack | 12 (root `packageManager: pnpm@12.11.2`) | Workspaces, strict dependency isolation, fast installs. |
| Turborepo | 2.11 | Task graph and caching for `build`, `typecheck`, `test`. |
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
| Components | shadcn-style copy-in components | no version | Source-owned components in `apps/web/components/ui/primitives.tsx` (`class-variance-authority`, `tailwind-merge`); no Radix dependency yet; no component-library lock-in. |
| Icons | lucide-react | current major | Tree-shakable icon set. |
| Theming | next-themes | 0.4 | Dark/light theme switching. |
| ORM / migrations | Drizzle ORM 0.45 + drizzle-kit 0.31 | 0.45.4 / 0.31 | Typed schema, SQL-first generated migrations, supports SQLite and PostgreSQL dialects (portability). |
| Database driver | built-in `node:sqlite` (`DatabaseSync`) wrapped by Drizzle `sqlite-proxy` | Node built-in | No native compilation on `npx` install; works on all platforms Node supports. |
| Validation | Zod | 4.6 | Single source for config, definition format v1 and API input schemas; JSON Schema export for the benchmark format. |
| CLI parsing | commander | 15 | Mature, small, typed subcommands. |
| YAML | yaml | 2.9 | YAML 1.2 parser for benchmark definitions and frontmatter. |
| Unit / integration tests | Vitest | 5.0 | Fast TS-native runner across packages. |
| E2E tests | Playwright | 1.64 | Browser smoke test against the real `serve` process ([SPEC-012](2026-10-14-testing-strategy.md)); `apps/web/e2e/smoke.spec.ts`, 7 tests passing. |
| Example fixture tests | `node --test` | Node built-in | Hidden verification tests in examples need no extra dependency in the workspace. |

## 3. Constraints and rationale details

### 3.1 Node version and `node:sqlite`

- `node:sqlite` is usable without `--experimental-sqlite` from Node 22.13.0.
- The database client (`packages/database/src/client.ts`) calls `StatementSync#setReturnArrays`, added in Node 22.16.0 / 24.0.0, because Drizzle `sqlite-proxy` expects rows as arrays. Therefore `engines.node` is **`>=22.16.0`** (as declared in the root `package.json`), not `>=22.13.0`.
- **Only Node 24 (24.21) has been verified.** Node 22.16+ support is declared but untested — Assumption — requires validation.
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
- **Implemented (verified by `pnpm test:e2e`, 7/7 passing against the built CLI):** Playwright 1.64 smoke test (`apps/web/e2e/smoke.spec.ts`).
- **Implemented — CI:** the workflow (`.github/workflows/ci.yml`, Node 24 on `ubuntu-latest`: install, `pnpm audit --prod`, format check, lint, typecheck, test, build, `verify:pack`, Playwright) ran green on PR #1 on 2026-10-14 (before the audit step was added). §4.7 `pnpm audit --prod` is a CI step since 2026-10-15 and was clean when run locally that day; it has not yet run in CI.
- **Not implemented / unverified:** CI on Node 22, Windows and macOS; dependency-direction checks in CI; suppression of the `node:sqlite` experimental warning; JSON Schema export for the benchmark format.
