---
id: SPEC-009
title: CLI Architecture
status: draft
created: 2026-10-14
updated: 2026-10-14
category: foundation
related: [SPEC-003, SPEC-006, SPEC-007, SPEC-008, SPEC-010, SPEC-012, SPEC-114, SPEC-115, ADR-0001, ADR-0004, ADR-0007]
---

# SPEC-009 — CLI Architecture

## 1. Scope

The `directivebench` npm package (`apps/cli`): commands, options, environment variables, exit codes, process lifecycle and packaging. Installation and first-run experience from the user's point of view is in [SPEC-010](2026-10-14-local-installation.md); distribution rationale in [ADR-0004](../decisions/0004-native-cli-distribution.md).

`apps/cli` is the **only publishable package**. It is built with tsup, which bundles the internal workspace packages (`@directivebench/*`) into `dist/cli.js`. The prebuilt Next.js app is shipped alongside it.

## 2. Commands

| Command | Status | Behaviour |
| --- | --- | --- |
| `directivebench` | Implemented (bootstrap) | Same as `serve` (opens the browser unless `--no-open`). |
| `directivebench serve` | Implemented (bootstrap) | Full startup sequence (§5): migrate, recover jobs, start runner, start web UI. |
| `directivebench init` | Implemented (bootstrap) | Create/validate the data directory, write default `config.json` if absent, run migrations, seed predefined categories. Does not start servers. Idempotent. |
| `directivebench doctor` | Implemented (bootstrap) | Diagnose the environment (§4). Read-only (never creates or migrates anything); exits non-zero if a required check fails. |
| `directivebench demo` | Implemented (bootstrap) | Headless: init → import bundled example artifact and benchmark (`dist/examples`) → run it with the Mock Agent → print a RED/GREEN summary labelled "Mock agent — not an AI evaluation". |
| `directivebench --help`, `-h` | Implemented (bootstrap) | Usage for the program or a subcommand. |
| `directivebench --version`, `-V` | Implemented (bootstrap) | Prints the package version. |
| `sync` | Future | Synchronize registered repositories ([SPEC-105](2026-10-14-repository-synchronization.md)). |
| `benchmark run`, `benchmark list` | Future | Run/list benchmarks headless ([SPEC-110](2026-10-14-benchmark-execution.md)). |
| `export`, `import` | Future | Portable export/import of registry and results. |
| `backup`, `restore` | Future | Consistent SQLite backup into `<dataDir>/backups/` and restore. |
| `runner` | Future | Standalone runner process; later a remote runner ([SPEC-114](2026-10-14-runner-management.md), [SPEC-011](2026-10-14-self-hosting-architecture.md)). |

Future commands must not be registered as stubs that pretend to work; until implemented they are absent from `--help`.

## 3. Options and environment variables

| Option | Env var | Default | Applies to | Notes |
| --- | --- | --- | --- | --- |
| `--host <host>` | `DIRECTIVEBENCH_HOST` | `127.0.0.1` | serve | Non-loopback values require `--allow-network-access`. |
| `--port <port>` | `DIRECTIVEBENCH_PORT` | `4280` | serve | Integer 1–65535. |
| `--data-dir <path>` | `DIRECTIVEBENCH_DATA_DIR` | OS default ([SPEC-010](2026-10-14-local-installation.md#5-data-directory)) | all | Resolved to an absolute path. |
| `--no-open` | — | open | serve | Do not open a browser. |
| `--allow-network-access` | — | off | serve | Permits non-loopback `--host`; prints an "unauthenticated instance" warning ([SPEC-007](2026-10-14-security-and-privacy.md)). |

Precedence: command-line option > environment variable > `config.json` > built-in default. All values are validated (Zod) before any side effect.

## 4. `doctor` checks

Node.js version against the supported range; `node:sqlite` availability; data directory resolvable and writable; `config.json` valid; database opens and migrations are up to date (reported, not applied); port availability on the configured host/port; bundled web build present (`dist/web/.next`); agent CLI detection (`claude`, `codex`, `cursor-agent`: on PATH + `--version`, informational only). Each check prints `ok`, `warn` or `fail` with a remediation hint. Output never includes secrets.

## 5. Startup sequence (`serve`)

```mermaid
sequenceDiagram
    participant U as User
    participant C as CLI process
    participant D as SQLite (data dir)
    participant R as Runner loop (in CLI)
    participant W as next start (child)
    participant B as Browser
    U->>C: npx directivebench
    C->>C: validate Node version + options
    C->>D: ensure data dir, load/create config.json
    C->>D: run migrations (WAL, busy_timeout)
    C->>D: seed predefined categories (idempotent)
    C->>D: recover stale running jobs → interrupted
    C->>C: check port is free
    C->>R: start runner (concurrency from config)
    C->>W: spawn next start -H host -p port<br/>env DIRECTIVEBENCH_DATA_DIR, host allowlist
    loop until ready or timeout
        C->>W: GET /api/health
    end
    C->>U: print URL (http://127.0.0.1:4280)
    C->>B: open URL (unless --no-open)
```

The CLI process is the supervisor: it owns the runner and the web child. The web process only reads the database and enqueues jobs ([SPEC-008](2026-10-14-api-architecture.md)).

## 6. Process supervision and shutdown

- The web server runs as a child process (`node <next>/dist/bin/next start <dist/web>`), with stdout/stderr piped to the CLI (prefixed) and to `<dataDir>/logs/`.
- If the child exits unexpectedly, the CLI stops the runner, marks running jobs `interrupted`, and exits non-zero. No automatic restart in bootstrap.
- Readiness: poll `GET /api/health` until `200` or 30 s timeout (then exit with an error).
- **Graceful shutdown** on `SIGINT`/`SIGTERM` (and Windows Ctrl+C): stop acquiring jobs → abort running jobs via `AbortSignal` → mark them `interrupted` → terminate agent subprocesses → send `SIGTERM` to the web child (force kill after 5 s) → close the database → exit. A second signal forces immediate exit.

## 7. Browser opening

Uses the platform opener (`open` on macOS, `xdg-open` on Linux, `start` via `cmd /c` on Windows) without a shell interpolation of the URL. Failure to open is a warning, never an error; the URL is always printed. Skipped with `--no-open`, and skipped automatically when no display is available (e.g. `CI` set, or Linux without `DISPLAY`/`WAYLAND_DISPLAY`).

## 8. Port conflicts

Before spawning the web server the CLI checks the port on the target host. If it is in use, the CLI exits with code 4 and a message suggesting `--port <other>`; it does not silently pick another port (the URL must be predictable). Detecting an already running DirectiveBench instance on that port and opening it instead is a possible future improvement.

## 9. Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (including clean shutdown after a signal) |
| 1 | Unexpected/runtime error |
| 2 | Invalid usage or configuration (bad option, invalid `config.json`, non-loopback host without `--allow-network-access`) |
| 3 | Unsupported runtime (Node.js version, missing `node:sqlite`) |
| 4 | Port in use |
| 5 | Data directory or migration failure |
| 6 | `doctor` found at least one failing check / `demo` benchmark did not produce the expected result |

These values are a target contract; the implementation must match this table or this table must be updated.

## 10. Packaging layout

```text
directivebench/            # published npm package (apps/cli)
├── package.json           # "bin": {"directivebench": "dist/cli.js"}, engines.node, runtime deps (next, react, react-dom, …)
├── LICENSE
├── README.md
└── dist/
    ├── cli.js             # tsup bundle with shebang; includes @directivebench/* workspace code
    ├── web/               # prebuilt Next.js app: .next/ (build output), public/, next.config.mjs
    ├── migrations/        # SQL migrations + drizzle meta journal
    └── examples/          # bundled example artifacts and benchmarks used by `demo`
```

- **File resolution:** all bundled assets are resolved relative to the CLI file (`path.dirname(fileURLToPath(import.meta.url))` → `dist/`), never relative to `process.cwd()`. The `next` binary is resolved with `createRequire(import.meta.url).resolve('next/package.json')`.
- Development mode (running from source) resolves the same assets from `apps/web`, `packages/database/migrations` and `examples/` through a single resolver function, so both modes share one code path.
- No native compilation: SQLite uses built-in `node:sqlite` ([ADR-0002](../decisions/0002-sqlite-with-node-sqlite.md)).

## 11. Packaging verification

`pnpm verify:pack` (`scripts/verify-pack.mjs`): build → `npm pack` in `apps/cli` → install the tarball into a fresh temp directory → run `directivebench --help` and `--version` → start `serve --no-open --port <free> --data-dir <temp>` and wait for `GET /api/health` → shut down via `SIGTERM` and assert a clean exit. It also asserts the tarball contains the paths in §10 and no source maps of private paths or `.env` files. Details in [SPEC-012](2026-10-14-testing-strategy.md).

## 12. Implementation status

- **Implemented in bootstrap (to be verified, see [SPEC-013](2026-10-14-implementation-roadmap.md) Milestone 0):** commands `directivebench`/`serve`, `init`, `doctor`, `demo`, `--help`, `--version`; options and env vars in §3; startup sequence; runner embedded in the CLI process; web child process; graceful shutdown; packaging layout and `verify:pack` script.
- **Partially implemented / to reconcile:** the exact exit code values (§9) and port-conflict behaviour (§8) must be checked against the code.
- **Not implemented:** `sync`, `benchmark run|list`, `export`, `import`, `backup`, `restore`, `runner`; automatic restart of the web child; detection of an already running instance.
