---
id: SPEC-010
title: Local Installation
status: draft
created: 2026-10-14
updated: 2026-10-21
category: foundation
related: [SPEC-004, SPEC-006, SPEC-007, SPEC-009, SPEC-115, ADR-0001, ADR-0002, ADR-0004, ADR-0008]
---

# SPEC-010 — Local Installation

## 1. Scope

What a user needs to run DirectiveBench locally, what happens on first run, where data lives, how upgrades and removal work, and how to troubleshoot. CLI internals are in [SPEC-009](2026-10-14-cli-architecture.md); configuration keys in [SPEC-115](2026-10-14-settings-and-configuration.md).

## 2. Requirements

| Requirement | Value |
| --- | --- |
| Node.js | `>= 22.16.0` (built-in `node:sqlite` incl. `StatementSync#setReturnArrays`; see [ADR-0002](../decisions/0002-sqlite-with-node-sqlite.md) and [SPEC-004 §3.1](2026-10-14-technology-stack.md#31-node-version-and-nodesqlite)). Verified on Node 24.21 only. The authoritative range is `engines.node` in the published `package.json`. |
| npm | Bundled with Node (for `npx`). pnpm/yarn `dlx` are expected to work but are not verified. |
| OS | Linux, macOS, Windows (x64/arm64). No native compilation, no build tools. |
| Disk | ~ size of the package plus data directory growth (fixture snapshots, logs). |
| Network | Only to download the package. DirectiveBench itself makes no network calls in bootstrap. |
| Optional | Agent CLIs (`claude`, `codex`, `cursor-agent`) are only detected, not required. `git` will be required for repository features (future). |

## 3. Running

```sh
npx directivebench            # start the local UI on http://127.0.0.1:4280 and open the browser
npx directivebench demo       # headless demo with the deterministic Mock Agent
npx directivebench doctor     # environment diagnostics
npm install -g directivebench # optional global install; then run `directivebench`
```

## 4. First run

1. Node version is checked; unsupported versions exit with a clear message (exit code 3, [SPEC-009](2026-10-14-cli-architecture.md#9-exit-codes)).
2. The data directory is created with user-only permissions where the OS supports it (`0700` on POSIX).
3. `config.json` is written with defaults (atomic write).
4. SQLite database `directivebench.db` is created in WAL mode and all migrations are applied.
5. Predefined categories are seeded (idempotent).
6. The runner starts, the web UI starts on `127.0.0.1:4280`, and the browser opens.

No account, telemetry, or network access is involved ([ADR-0001](../decisions/0001-local-first-architecture.md)). The registry is empty until the user runs `demo` or imports content; the UI shows honest empty states.

## 5. Data directory

| OS | Default location |
| --- | --- |
| Linux | `$XDG_DATA_HOME/directivebench`, falling back to `~/.local/share/directivebench` |
| macOS | `~/Library/Application Support/directivebench` |
| Windows | `%LOCALAPPDATA%\directivebench` |

Override with `--data-dir` or `DIRECTIVEBENCH_DATA_DIR`.

| Path | Contents |
| --- | --- |
| `config.json` | User configuration (Zod-validated, atomic writes) |
| `directivebench.db` (+ `-wal`, `-shm`) | SQLite database |
| `fixtures/<sha256>/` | Content-addressed, immutable fixture snapshots |
| `logs/` | `web.log` — output of the Next.js child process (appended; not redacted); `runner.log` — runner lifecycle events as redacted JSON lines (mode `0600`; also printed to stderr). Other CLI messages go to the terminal. |
| `cache/` | Future: git clones |
| `backups/` | Future: database backups |

Temporary benchmark workspaces live outside the data directory in `<os tmpdir>/directivebench/workspaces/<benchmarkRunId>/<caseId>/<variant>-<rep>/{workspace,home}` and are removed after each run unless `runner.keepWorkspaces` is enabled.

## 6. Configuration

`config.json` holds non-secret settings: `configVersion` (`1`), `server.host` (`127.0.0.1`), `server.port` (`4280`), `server.openBrowser` (`true`), `runner.concurrency` (`1`, max 16), `runner.keepWorkspaces` (`false`). Unknown keys are rejected (strict schema in `packages/core/src/config.ts`; full reference in [SPEC-115](2026-10-14-settings-and-configuration.md)). Precedence: CLI option > environment variable > `config.json` > default. An invalid file stops startup with exit code 2 and the Zod error path; it is never silently overwritten. Secrets are never written to `config.json` or the database in plaintext; OS keychain storage is planned ([ADR-0008](../decisions/0008-secret-storage-and-authentication.md)). No secrets exist in bootstrap.

## 7. Upgrades and migrations

- `npx directivebench@latest` (or reinstall globally) to upgrade. Data stays in the data directory.
- On every `init`/`serve` (and `demo`), pending migrations are applied in order inside one `BEGIN IMMEDIATE` transaction (Drizzle `sqlite-proxy` migrator). Migrations are forward-only.
- Before applying migrations to an existing database, the CLI SHOULD copy the database to `backups/pre-migration-<timestamp>.db` (planned; not in bootstrap).
- Running an **older** CLI against a database migrated by a newer version SHALL be refused with a clear message (no downgrade support; detection not implemented yet).
- Immutable records (artifact versions, suite versions, fixture snapshots) are never rewritten by migrations.

## 8. Uninstall and data removal

1. Stop DirectiveBench (Ctrl+C).
2. `npm uninstall -g directivebench` if installed globally; for `npx`, optionally clear the npm cache (`npm cache clean --force`).
3. Delete the data directory (path printed by `directivebench doctor`) to remove all local data.
4. Optionally delete `<os tmpdir>/directivebench/` (leftover workspaces if `runner.keepWorkspaces` was on or a run crashed).

DirectiveBench writes nothing outside the data directory, the temp workspace directory and the npm cache. Future keychain entries will be listed by `doctor` and removable via a dedicated command.

## 9. Troubleshooting

Run `directivebench doctor` first; it checks Node version, `node:sqlite`, data directory existence and writability, config validity, migration state, port availability, the bundled web build and agent CLI detection, and prints a remediation hint for every check that is not `ok` ([SPEC-009 §4](2026-10-14-cli-architecture.md#4-doctor-checks)).

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Unsupported runtime: Node.js … (requires >= 22.16.0)" | Node < 22.16.0 | Install Node 24 LTS |
| "Port 4280 on 127.0.0.1 is already in use" (exit 4) | Another process or instance | `--port 4281` or stop the other process |
| `database is locked` errors | Another tool holding a write lock | Close other SQLite clients; WAL + `busy_timeout` handles normal concurrency |
| Browser does not open | Headless environment | Open the printed URL manually; use `--no-open` |
| Invalid config | Manual edit error | Fix the path reported in the error, or delete `config.json` to regenerate defaults |

## 10. Offline behaviour

After the package is installed (or present in the npm cache), DirectiveBench works fully offline: UI, registry, mock benchmarks and the demo. Features that inherently need the network (future repository sync with remote hosts, hosted model providers) will report an explicit offline/connection error rather than failing silently.

## 11. Proxies and VPNs

- Package download uses npm's own proxy settings (`npm config set proxy/https-proxy`).
- The UI is served on loopback, so corporate proxies are not involved; if a system proxy intercepts `127.0.0.1`, add it to `NO_PROXY`.
- Some VPN or endpoint-security tools block loopback ports; use `--port` to pick an allowed port.
- Future outbound integrations (git hosts, model providers) should honour `HTTPS_PROXY`/`NO_PROXY`. Assumption — requires validation per integration.

## 12. Publishing releases

- The `directivebench` package is published to npm from CI only, by `.github/workflows/release.yml`
  when a GitHub release is published. The first version (0.1.0) was published by hand because
  npm configures a trusted publisher only for an existing package.
- The workflow authenticates with npm trusted publishing (OIDC, `id-token: write`); no npm token is
  stored in the repository. Every published version carries npm provenance, linking it to the
  commit and workflow run that built it.
- Before publishing, the workflow refuses a release whose tag is not `v<version>` of
  `apps/cli/package.json` and runs `pnpm build` and `pnpm verify:pack`, so only a package that
  passed the packaging smoke test is published.
- A release marked as a pre-release is published under the npm dist-tag `next`, any other under
  `latest`.

## 13. Implementation status

- **Implemented (verified by `pnpm verify:pack` on 2026-10-14 — packed tarball installed with npm into an empty project, Node 24.21, Linux):** running the installed `directivebench` binary (`--help`, `--version`, `demo`, `serve`); `init` and `doctor` commands (data-dir writability and remediation hints verified by `apps/cli/test/cli.test.ts` on 2026-10-15); `runner.log` written by `serve`; Node version check (exit 3); data directory resolution with `--data-dir`/`DIRECTIVEBENCH_DATA_DIR` overrides and OS defaults (`packages/core/test/config.test.ts`); data directory created with mode `0700`; `config.json` strict validation and atomic `0600` writes (`config.test.ts`); migrations and category seeding on `init`/`serve`/`demo`; workspace cleanup after runs unless `runner.keepWorkspaces`.
- **Partially implemented:** the macOS data-dir path is covered by a unit test only and the Windows path by none (neither platform has been run); `npx directivebench` from the npm registry is untested because nothing is published yet.
- **Not implemented:** pre-migration automatic backup, downgrade refusal, keychain secrets, `backup`/`restore` commands, proxy support for outbound integrations (no outbound integrations exist yet).
