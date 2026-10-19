---
id: SPEC-007
title: Security and Privacy
status: draft
created: 2026-10-14
updated: 2026-10-19
category: foundation
related: [SPEC-003, SPEC-006, SPEC-008, SPEC-009, SPEC-011, SPEC-104, SPEC-105, SPEC-107, SPEC-110, SPEC-112, SPEC-115, SPEC-203, SPEC-204, SPEC-205]
---

# Security and Privacy

Decisions: [ADR-0007 local runner execution and isolation](../decisions/0007-local-runner-execution-and-isolation.md), [ADR-0008 secret storage and authentication](../decisions/0008-secret-storage-and-authentication.md). API-level controls: [SPEC-008](2026-10-14-api-architecture.md). CLI flags: [SPEC-009](2026-10-14-cli-architecture.md).

## 1. Assets and trust boundaries

| Asset | Where |
|---|---|
| User source code and private repositories | Repository cache, workspaces, fixtures |
| Credentials (git tokens, model API keys, agent CLI logins) | OS keychain (planned), agent CLIs' own config dirs (`~/.claude`, `~/.codex`, …) |
| Benchmark results and traces | SQLite DB, logs |
| The user's machine | Everything executed by the runner |

```mermaid
flowchart LR
  subgraph Trusted["Trusted: DirectiveBench code + user"]
    CLI[CLI + runner]
    WEB[Web server 127.0.0.1]
  end
  subgraph Untrusted
    REPO[Imported repositories / artifacts]
    BENCH[Benchmark definitions, fixtures, setup & assertion commands]
    AGENT[Agent / model behaviour]
    SITE[Other websites in the user's browser]
    HOST[User-configured git / provider hosts]
  end
  REPO -->|parse only| CLI
  BENCH -->|execute only when approved| CLI
  AGENT -->|edits workspace| CLI
  SITE -.->|DNS rebinding / CSRF| WEB
  CLI -->|HTTPS| HOST
```

## 2. Threat model

| ID | Threat | Vector | Primary controls |
|---|---|---|---|
| T1 | **Untrusted imported repositories** | Malicious artifact files (huge files, binary blobs, crafted frontmatter, prompt injection aimed at agents). | Parse-only (never execute repo content during discovery); path-based classification; size limits; YAML parsed without custom tags; content rendered as text/escaped markdown in UI (no raw HTML). Prompt injection inside artifacts is an inherent property of what is being evaluated — surfaced, not prevented. |
| T2 | **Untrusted benchmark scripts** | `setup` and `command` assertions run arbitrary programs; agents edit code that tests then execute. | Execution approval per suite version; argv-only; env allowlist; timeouts + process-tree kill; output limits; "Not sandboxed" labelling; Docker sandbox (planned). |
| T3 | **Malicious websites vs localhost** | DNS rebinding to `127.0.0.1:4280`; cross-site form posts / fetch to server actions or `/api/*`. | Loopback binding; Host allowlist in `proxy.ts`; Origin checks for server actions and mutating route handlers; no CORS headers; JSON content-type required for API mutations. |
| T4 | **Secret leakage** | API keys/tokens appearing in agent output, command output, traces, logs, reports, exports, error messages. | No secrets stored in bootstrap; env allowlist (secrets not forwarded to commands); `redactSecrets` on all captured output before persistence; `isSecretEnvName` filter; exports exclude secret refs. |
| T5 | **SSRF via user-configured hosts** | Self-managed GitLab / custom provider base URL pointing at internal services or cloud metadata (`169.254.169.254`). | Planned: scheme allowlist (`https`, `http` only for loopback with explicit opt-in), resolve-and-check IP (deny link-local/metadata ranges; private ranges require explicit confirmation since self-managed hosts are often private), no redirects to different hosts, response size/time limits. |
| T6 | **Path traversal & symlinks** | Fixtures, overlays, artifact file manifests, agent-written files, archive imports containing `../` or symlinks to `~/.ssh`. | Symlinks rejected at fixture/overlay snapshot and artifact import; every relative path normalized and verified to stay under root (`realpath` prefix check); artifact install writes only under the adapter's install directory. |
| T7 | **Supply chain** | Compromised npm dependency; malicious example suites. | Minimal runtime dependencies, lockfile, no install scripts in the published package, `pnpm audit` in CI, bundled examples reviewed in-repo ([SPEC-004](2026-10-14-technology-stack.md#4-dependency-policy)). |
| T8 | **Network exposure** | User binds to `0.0.0.0` on an untrusted network; no auth in MVP. | Non-loopback host refused without `--allow-network-access`; loud warning when enabled; Host allowlist still applies. |
| T9 | **Local agent CLI credentials** | Real agents run with the user's logged-in CLI session; a benchmark prompt or fixture could induce exfiltration. | Agents are invoked only on explicit user action; future Docker mode does not mount credentials by default (§5.3); traces redacted; documented risk. |

## 3. Controls

### 3.1 Implemented in bootstrap (see Implementation status for verification)

| Control | Description |
|---|---|
| Loopback binding | Default host `127.0.0.1` (`DEFAULT_HOST`), port 4280. `isLoopbackHost()` gates the `--allow-network-access` requirement. |
| `--allow-network-access` | Required for any non-loopback `--host`; prints a warning that there is no authentication. |
| Host allowlist (`apps/web/proxy.ts`) | Requests whose `Host` header host name (any port) is not `localhost`, `127.0.0.1` or `[::1]` — plus the explicit non-loopback `--host` value, passed by the CLI in `DIRECTIVEBENCH_ALLOWED_HOSTS` — are rejected with 403. DNS-rebinding protection. |
| Server action origin checks | Next.js server actions compare `Origin` with `Host` (framework default; `serverActions.allowedOrigins` is not configured). There are no mutating route handlers yet. |
| argv-only commands | `spawn(argv[0], argv.slice(1), { shell: false })`; no string commands. |
| Env allowlist | Commands receive only `PATH`, `LANG`, `LC_ALL`, `TZ` (plus `SystemRoot`, `PATHEXT`, `COMSPEC` on Windows), `HOME`/`USERPROFILE`/`TMPDIR`/`TEMP`/`TMP` set to a per-run temp dir, `CI=true` and `NO_COLOR=1` (`buildCommandEnv`). No other variable — in particular no secret — is forwarded. |
| Git environment for repository inspection | Repository registration ([SPEC-104](2026-10-14-repository-management.md) FR-104-12) runs git with its own allowlist: absolute `PATH` entries only (git itself is located on them and spawned by absolute path, never resolved against the repository), `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME` (the user's global git config, e.g. `safe.directory`), `SystemRoot`, plus `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_NO_LAZY_FETCH=1`, `LC_ALL=C`; hooks and fsmonitor are disabled with `-c`. Unlike benchmark commands, `HOME` is the real one, because git never runs repository code under these settings. |
| Timeouts & output limits | Per-command timeout; on timeout/cancel the process group receives `SIGTERM`, then `SIGKILL` after a 5 s grace period; output truncated to `maxOutputBytes`, then redacted. |
| Execution approval | Commands run only if `benchmark_suite_versions.execution_approved_at` is set; checked by the web app before enqueueing and again by the engine before running. Bundled examples are approved at import with `execution_approval_source = 'bundled-example'`. User approval UX is planned. |
| Symlink & traversal rejection | Fixture and overlay snapshotting rejects symlinks and escaping paths. |
| Redaction | `redactSecrets(text, knownSecrets)` in `packages/core/src/redact.ts` (provider key shapes, GitHub/GitLab/Slack tokens, AWS key IDs, bearer headers, private-key blocks) applied to captured command output before it is returned and persisted, and to every line of `logs/runner.log` (written with mode `0600`). Agent traces and `logs/web.log` are not redacted yet. |
| No credentials stored | Bootstrap stores no secrets anywhere; mock agent needs none. |
| Config file permissions | `config.json` written atomically with mode `0600`. |
| Data directory permissions | The data directory and its subdirectories are created with mode `0700`; existing directories are left unchanged. |

### 3.2 Planned

- Execution approval UX: show the full list of commands (setup + assertions) with argv before approving; approval recorded per suite version; re-approval required for every new version.
- OS keychain secret storage with DB-side references only ([ADR-0008](../decisions/0008-secret-storage-and-authentication.md)); known secret values passed to `redactSecrets`.
- SSRF controls (T5), TLS policy (§7), Docker sandbox (§5.2).
- DB file permission hardening (`0600`); the data directory itself is already created with `0700` (§3.1).
- Content-Security-Policy headers for the web UI (no inline scripts beyond Next.js needs).

## 4. Command execution rules (normative)

1. No shell. A `command` is a non-empty string array.
2. `cwd` is the workspace root; the engine refuses to run if it cannot verify the workspace is under the OS tmp workspace root.
3. Environment = allowlist only; adapters may add documented, non-secret variables.
4. Every process has a timeout; on timeout/cancel the process (and on POSIX its process group) is killed.
5. Output capture is bounded; truncation is recorded explicitly in the result.
6. Captured output is redacted before it reaches the DB, logs or UI.
7. Workspaces are deleted after the run unless `runner.keepWorkspaces` is true.

## 5. Sandboxing

### 5.1 `local-process` is NOT a sandbox

Processes run as the user with full filesystem and network access. The controls in §4 reduce accidents and leakage; they do not contain a malicious program. The UI and reports label every such run "Not sandboxed", and `sandboxed=false` is part of recorded environment metadata.

### 5.2 Docker environment (planned)

| Setting | Value |
|---|---|
| Network | `--network none` by default; opt-in allowlisted egress per suite (later) |
| Mounts | Fixture snapshot read-only; workspace as the only writable bind mount (or a copy inside the container); no home directory, no Docker socket |
| User | Non-root UID; `--cap-drop ALL`; `--security-opt no-new-privileges`; read-only root filesystem with tmpfs `/tmp` |
| Resources | `--memory`, `--cpus`, `--pids-limit`, wall-clock timeout enforced by the runner |
| Credentials | No SSH keys, git credentials, cloud credentials or agent CLI config mounted by default |
| Images | Pinned by digest in the suite definition; pulled only with user consent |

If Docker is unavailable, the runner fails the job with a clear `infrastructure-error` — never silently falls back to `local-process`.

### 5.3 Authenticated local agent CLIs and sandboxes

Real agents (Claude Code, Codex, Cursor Agent) authenticate with credentials stored in their own user-level config, and need network access to their model APIs. Consequences:

- In `local-process`, the agent runs with the user's login and can reach anything the user can. User-level skills/instructions in the agent's own config dirs cannot be excluded and are recorded as an uncontrolled difference ([SPEC-112](2026-10-14-red-green-evaluation.md)).
- In `docker`, the agent needs (a) a token passed via an environment variable or a minimal mounted credential file, and (b) egress to its provider endpoint only. Each adapter declares the credential mechanism it supports; mounting the full `~/.claude`/`~/.codex` directory is not allowed. Per-agent support: Assumption — requires validation ([SPEC-203](2026-10-14-integration-claude-code.md), [SPEC-204](2026-10-14-integration-openai-codex.md), [SPEC-205](2026-10-14-integration-cursor.md)).
- Setup and assertion commands always run without agent credentials, even when the agent step has them.

## 6. Privacy

- **No telemetry**, analytics, crash reporting or update pings. Next.js telemetry disabled for the spawned server.
- Nothing leaves the machine except **user-initiated** calls: git fetches to configured hosts, model/agent provider calls made by the agent or harness the user selected, and `npx` package download itself.
- All data (DB, fixtures, logs, cache) stays in the data directory; users can delete it at any time.
- Reports and exports (planned) contain artifact content and traces; they are produced only on explicit action and exclude secret references.

## 7. TLS

- Never disable certificate verification (`NODE_TLS_REJECT_UNAUTHORIZED=0` is not set, not suggested, and `doctor` warns if it is present in the environment).
- Custom CA support for self-managed GitLab / internal providers via Node's `NODE_EXTRA_CA_CERTS` or a configured CA bundle path in `config.json` (planned), applied per connection.

## 8. Credential boundaries for a future shared server

- Secrets are owned by a user or a team scope, encrypted at rest server-side, and never returned to clients after creation (write-only).
- Runners receive short-lived, job-scoped credentials only for the providers that job needs; credentials are never written to the workspace.
- Results and traces are redacted before upload; access to traces follows repository/team permissions.
- Authentication, roles and CSRF/session controls replace the loopback-only assumption. Details: [SPEC-011](2026-10-14-self-hosting-architecture.md).

## Implementation status

- **Implemented (verified by tests or `pnpm verify:pack` on 2026-10-14):** `DEFAULT_HOST = 127.0.0.1`, `isLoopbackHost`, atomic `config.json` writes with mode `0600` (`packages/core/test/config.test.ts`); `redactSecrets` (`core` tests); non-loopback host refused without `--allow-network-access` (`apps/cli/test/cli.test.ts`); Host allowlist in `proxy.ts` rejecting a foreign `Host` with 403 (`verify:pack`); argv-only command execution without a shell, env allowlist, timeouts, truncation and redaction (`benchmark-engine` "runCommand" tests); execution approval flag — unapproved suites do not run commands (`engine.test.ts`, `runner.test.ts`), bundled examples auto-approved at import; fixture symlink/traversal rejection (`engine.test.ts`); artifact install path-escape rejection (`agent-adapters` tests); "Not sandboxed" warning on every run; `NEXT_TELEMETRY_DISABLED=1` for the web child.
- **Implemented (verified on 2026-10-15):** `SIGTERM` → `SIGKILL` process-group termination (`engine.test.ts` "sends SIGTERM first and SIGKILL only after the grace period"); approval re-checked before enqueueing (Playwright "enqueueing re-checks execution approval on the server (FR-114-02)"); redacted runner log `logs/runner.log` with mode `0600` (inspected after the Playwright run); `pnpm audit --prod` step in CI (clean locally on 2026-10-15; not yet run in CI); data directory created with mode `0700` on creation (`apps/cli/src/setup.ts`; not re-applied to existing directories, by design).
- **Partially implemented:** server action origin checks rely on the Next.js default and are not covered by a test; "Not sandboxed" badge in the UI is not covered by a UI test.
- **Not implemented:** approval UX, keychain secret storage, SSRF controls, custom CA configuration, `doctor` TLS warning, Docker sandbox, CSP headers, DB file permission hardening, redaction of agent traces and web logs, shared-server credential model.
