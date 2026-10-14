---
id: SPEC-205
title: Cursor Agent CLI agent adapter
status: draft
created: 2026-10-14
updated: 2026-10-14
category: integration
related: [SPEC-003, SPEC-007, SPEC-012, SPEC-102, SPEC-110, SPEC-112, SPEC-115, SPEC-203, SPEC-204, ADR-0006, ADR-0007, ADR-0008, ADR-0009]
---

# SPEC-205 — Cursor Agent CLI agent adapter

## 1. Purpose

Let DirectiveBench run benchmark cases with the **Cursor Agent CLI** (headless counterpart of Cursor's agent; binaries `cursor-agent` and `agent`) as an agent harness. The adapter measures how Cursor rules (`.cursor/rules/*.mdc`), `AGENTS.md`/`CLAUDE.md` instructions and skills affect the agent in RED/GREEN runs ([SPEC-112](2026-10-14-red-green-evaluation.md)).

The adapter implements `AgentAdapter` (`packages/agent-adapters/src/contract.ts`; [SPEC-110 §8](2026-10-14-benchmark-execution.md); [ADR-0006](../decisions/0006-agent-adapters-vs-model-providers.md)) with adapter id `cursor` (as in the bootstrap detection descriptor). Shared contract extensions: [SPEC-203 §4.2](2026-10-14-integration-claude-code.md#42-contract-mapping-and-required-extensions).

Out of scope: the Cursor editor, Cloud Agents (`&` hand-off), `worker` (self-hosted cloud worker), `acp` mode, worktrees, MCP management.

### Evidence labels

**Confirmed (source, date)** = official docs or read-only local `--help`/`--version`. **Assumption — requires validation** = not verified.

| Key | Source (all checked 2026-10-14) |
| --- | --- |
| U1 | https://cursor.com/docs/cli/headless |
| U2 | https://cursor.com/docs/cli/reference/output-format |
| U3 | https://cursor.com/docs/cli/reference/authentication |
| U4 | https://cursor.com/docs/cli/reference/parameters |
| U5 | https://cursor.com/docs/cli/using |
| U6 | https://cursor.com/docs/cli/reference/permissions |
| U7 | https://cursor.com/docs/cli/reference/configuration |
| U8 | https://cursor.com/docs/context/rules |
| U9 | https://cursor.com/docs/context/skills |
| U10 | https://cursor.com/docs/agent/security/run-modes |
| U11 | https://cursor.com/docs/cli/overview |
| L3 | Local `cursor-agent --version` → `2026.10.14-0f9edde`; `cursor-agent --help` (usage line `agent`), `cursor-agent status --help`, `cursor-agent models --help`. On the test machine `cursor-agent` and `agent` are symlinks to the same versioned binary (Linux, 2026-10-14) |

## 2. Official integration options

| Option | Description | Status | Use |
| --- | --- | --- | --- |
| **CLI print mode** `agent -p` / `cursor-agent -p` | Non-interactive mode for scripts and CI. `--output-format text\|json\|stream-json`. | Confirmed (U1, U4, U11, L3) | **Primary.** |
| ACP server (`acp`) | Server mode for custom clients. Hidden command. | Confirmed as hidden (U4) | Not used. Protocol unverified. |
| Cursor SDK / public agent API for local execution | None found in the sources above. | Assumption — none exists | — |

## 3. Authentication methods

### 3.1 What the CLI supports

Confirmed (U3, U4, L3, 2026-10-14):

- **Browser login**: `agent login` (`NO_OPEN_BROWSER` prints the URL instead of opening a browser), `agent logout`, `agent status` / `whoami` (`--format text|json`).
- **API key**: `CURSOR_API_KEY` env var or `--api-key <key>`. It is a "user API key" created in the Cursor Dashboard. Service-account API keys are mentioned only for `worker --pool` (L3).
- Endpoint override: `-e/--endpoint` / `CURSOR_API_ENDPOINT` (default `https://api2.cursor.sh`). Custom headers: `-H`.
- `bedrock` command: "Configure AWS Bedrock usage for CLI" (L3). How it works: **Assumption — requires validation**. Not supported initially.
- Credential storage location: **not documented** (U3 says only "securely stored locally").

Both methods authenticate against the **Cursor account**. Model access and billing go through Cursor, not directly to a model vendor. "API Key Mode" for Cursor therefore still uses the user's Cursor plan/usage. How API-key usage is billed: **Assumption — requires validation**.

### 3.2 Local Subscription Mode (browser login)

- DirectiveBench spawns the user's logged-in CLI and never locates, reads, copies or uploads its stored credentials. No cookie extraction.
- The storage location is undocumented, so the agent process must run with the **real `HOME`** (declared exception to FR-110-42, agent process only). Whether a `CURSOR_CONFIG_DIR` override would also move the login: **Assumption — requires validation**, so it is not used in this mode.
- `CURSOR_API_KEY` is removed from the env so the mode label stays truthful. The `system/init` event field `apiKeySource` (`env|flag|login`, U2) is checked: the run fails with `auth-mode-mismatch` if it is not `login`.
- Readiness: `cursor-agent status --format json` (Confirmed that the command and flag exist, L3). JSON schema and whether it contacts the network: **Assumption — requires validation**. Raw output is never persisted.
- Terms for automated benchmarking under a Cursor plan: **Assumption — requires validation (terms review)**. Subscription credentials are never uploaded to a shared server ([ADR-0009](../decisions/0009-self-hosted-readiness.md)).

### 3.3 API Key Mode

- `CURSOR_API_KEY` is injected from a secret reference ([ADR-0008](../decisions/0008-secret-storage-and-authentication.md)) into the agent env only. The `--api-key` flag is **never** used, because argv is visible in process listings. `HOME`, `XDG_CONFIG_HOME` and `CURSOR_CONFIG_DIR` point to the run temp dir. The adapter writes a generated `cli-config.json` there (permissions, sandbox; §7).
- `apiKeySource` in `system/init` must be `env`.
- That the CLI runs correctly with a completely fresh `HOME` and only `CURSOR_API_KEY`: **Assumption — requires validation**.

## 4. Capability requirements

| Capability | Mechanism | Evidence |
| --- | --- | --- |
| **Detection** | Bootstrap: `cursor-agent` on `PATH`. Proposed: if it is absent, fall back to `agent`, accepting it only if `agent --version` matches the Cursor version pattern. `agent` is a generic name that may belong to another program. | Binary names: Confirmed (U11 uses `agent`; L3 has both). Long-term support of `cursor-agent`: Assumption |
| **Version** | `--version` / `-v` → `2026.10.14-0f9edde`; parse `^(\d{4}\.\d{1,2}\.\d{1,2})-([0-9a-f]+)$`. Compare versions by date. | Confirmed (L3) |
| **Auth readiness** | `status --format json` (subscription); secret ref resolves (API key). | Command: Confirmed (L3). Output: Assumption |
| **Execution modes** | `-p/--print` with the default agent mode. `--mode plan\|ask` are read-only and not used for benchmarks. | Confirmed (U4, L3) |
| **Model selection** | `--model <model>`. Parameterized forms such as `'claude-opus-4-8[context=1m,effort=high,fast=false]'` are recorded verbatim. `--list-models` / `models` list the account's models (network, user-triggered only). The model used is in `system/init.model` (U2). An `auto`-style model (U7 mentions `/model auto`) routes non-deterministically, so the adapter rejects it for comparability. | Confirmed (U2, U4, L3). `auto` semantics: Assumption |
| **Tool permissions** | `-f/--force` (`--yolo`): "Force allow commands unless explicitly denied". Permission config `permissions.allow/deny` with `Shell(commandBase)`, `Read(glob)`, `Write(glob)`; deny wins (U6). `--sandbox enabled\|disabled`. | Confirmed (U4, U6, L3) |
| **Write behaviour in print mode** | **Conflicting docs.** U1: without `--force` print mode "won't modify files". U5: "Cursor has full write access in non-interactive mode". L3 help: print mode "Has access to all tools, including write and shell". **Assumption — requires validation**: what is written and executed with and without `--force`. Until a recorded test settles this, the adapter always passes `--force`, and restricts it through permissions + sandbox (§7). | Conflict recorded |
| **Working directory** | `--workspace <workspace>` plus spawn `cwd` = workspace. `--trust` (headless only) to skip the trust prompt. | Confirmed (U4, L3). That headless runs need `--trust`: Assumption |
| **Instructions/skills injection** | Workspace files per §4.1. | See §4.1 |
| **Cancellation** | SIGINT → 5 s → SIGTERM → 5 s → SIGKILL (process group). Signal semantics: **Assumption — requires validation**. | Assumption |
| **Timeouts** | Enforced by DirectiveBench. No CLI flag found. | — |
| **Structured output** | `--output-format stream-json` (NDJSON). `json`/`result` are emitted **only on success**. On failure the process exits non-zero with stderr and the stream may end without `result` (U2). | Confirmed (U2) |
| **Traces** | `system/init` (`apiKeySource`, `cwd`, `session_id`, `model`, `permissionMode`), `user`, `assistant`, `tool_call` `started`/`completed` with `call_id`. Tool types: `readToolCall` (`args.path`), `writeToolCall` (`args.path`, `fileText`; result `linesCreated`, `fileSize`), other tools as `tool_call.function {name, arguments}`. The shell tool shape is undocumented (Assumption). `--stream-partial-output` is not used. | Confirmed (U2) |
| **File modification tracking** | Authoritative: the DirectiveBench manifest diff. Supplementary: `writeToolCall` events. | SPEC-110 / U2 |
| **Error normalization** | Exit code + stderr. No JSON error object exists (U2). See §9. | Confirmed (U2) |
| **Usage reporting** | **Not available.** No `usage` field is documented in `json` or `stream-json` (U2). `usage` stays `null`, and `duration_ms`/`duration_api_ms` from `result` are recorded. | Confirmed absence in docs (U2) |
| **Session hygiene** | No "ephemeral" flag found. Sessions may persist in the CLI's storage (Assumption). Each run is a new session (no `--resume`/`--continue`). | Assumption |

Declared `AgentCapabilities` once implemented: `execution: true`, `headless: true`, `modelSelection: true`, `artifactInstallation: true`, `structuredOutput: true`, `usageReporting: false`, `deterministic: false`.

### 4.1 Artifact install convention (candidate only)

| Format | Installed at | Evidence |
| --- | --- | --- |
| `cursor-rule` | `.cursor/rules/<name>.mdc` (frontmatter `description`, `globs`, `alwaysApply` preserved) | Confirmed: the CLI reads `.cursor/rules` (U5). Format: U8 |
| `agents-md` | `./AGENTS.md` (append if present, like the Mock Agent) | Confirmed: the CLI reads `AGENTS.md` at the project root (U5) |
| `claude-md` | `./CLAUDE.md` (append if present) | Confirmed: the CLI reads `CLAUDE.md` at the project root (U5) |
| `skill-md` | `.cursor/skills/<slug>/SKILL.md` | Path confirmed for Cursor (U9, which also lists `.agents/skills/`). **That the CLI loads skills: Assumption — requires validation** (U9 does not say). Until validated, skill runs with this adapter show a "skill loading unverified for Cursor CLI" warning |
| others | rejected before execution | DirectiveBench rule |

Fixture contents that interact with installs: existing `.cursor/rules`, `AGENTS.md`, `CLAUDE.md`, and skills under `.claude/skills`, `.codex/skills`, `.agents/skills` (Cursor loads all of these for compatibility, U9) are part of the fixture and therefore present in both variants. Nested `AGENTS.md` files apply to their subdirectories (U8).

## 5. Architecture

Code location (future): `packages/agent-adapters/src/cursor/` (`detect.ts`, `argv.ts`, `env.ts`, `config.ts` (generated `cli-config.json`), `install.ts`, `stream-parser.ts`, `normalize.ts`).

```mermaid
sequenceDiagram
  participant E as Engine
  participant A as CursorAdapter
  participant P as cursor-agent -p
  E->>A: run(request)
  A->>A: reject auto model / unsupported format / unapproved shell profile
  alt API Key Mode
    A->>A: temp HOME + CURSOR_CONFIG_DIR, write cli-config.json, CURSOR_API_KEY in env
  else Local Subscription Mode
    A->>A: real HOME, no CURSOR_API_KEY, warning ambient-user-config
  end
  A->>P: spawn argv (cwd=workspace, no shell), prompt on stdin (Assumption) or as last argv element
  P-->>A: NDJSON (system/init → … → result on success)
  A->>A: check init.apiKeySource matches mode; parse; redact
  P-->>A: exit code (+stderr on failure)
  A-->>E: AgentRunResult (usage null)
```

Prompt transport: the docs show the prompt as a positional argument (U1, U11). Reading the prompt from stdin: **Assumption — requires validation**. If stdin is not supported, the prompt goes in argv after a `--` separator (if supported, Assumption), with a length limit check (`prompt-too-long` error). Prompts are not secrets, but they appear in process listings in that case.

## 6. Relevant API or CLI interfaces

Canonical invocation:

```text
cursor-agent -p
  --output-format stream-json
  --workspace <workspace> --trust
  --force
  --sandbox enabled
  [--model <model>]
  <prompt>
```

| Interface | Notes | Evidence |
| --- | --- | --- |
| `--sandbox enabled\|disabled` | Linux: Landlock v3 (kernel ≥ 6.2) + seccomp + unprivileged user namespaces. macOS: Seatbelt. The sandbox blocks network by default, allows `/tmp`, protects `.git/config` and `.git/hooks`. If the Linux requirements are unmet, it "falls back to asking for approval" (U10, documented for the agent in general). That U10 applies identically to the CLI, and what "asking" means in print mode: **Assumption — requires validation**. The standalone CLI does not ship the AppArmor profile, so sandbox creation can fail on restricted distributions (U10). | Flag: Confirmed (U4, L3) |
| `sandbox.json` | `~/.cursor/sandbox.json` (global) and `<project>/.cursor/sandbox.json` (project wins). Team-admin policies layer on top (U10). | Confirmed (U10). CLI use: Assumption |
| `cli-config.json` | Global `~/.cursor/cli-config.json`, `$XDG_CONFIG_HOME/cursor/cli-config.json` (Linux), or `CURSOR_CONFIG_DIR`. Keys include `permissions`, `sandbox.mode`, `sandbox.networkAccess`, `sandbox.readBoundary` (`system`\|`workspace`), `model`, `version: 1`. Project `.cursor/cli.json` may set **only** permissions. | Confirmed (U6, U7). Precedence between `CURSOR_CONFIG_DIR` and `XDG_CONFIG_HOME`: Assumption |
| `--approve-mcps`, `--sandbox disabled`, `--api-key` | **Forbidden** (MCP auto-approval, no sandbox on unsandboxed host, secret in argv). | Flags: Confirmed (L3) |
| `-w/--worktree`, `--resume`, `--continue`, `--plugin-dir`, `-H`, `-e` | Not used. | Confirmed (L3) |
| `status --format json`, `models`, `about` | Readiness and diagnostics. | Confirmed (L3) |

## 7. Configuration

| Setting | Values | Default |
| --- | --- | --- |
| `binaryPath` | override | auto (`cursor-agent`, then validated `agent`) |
| `authMode` | `subscription` \| `api-key` | must be chosen explicitly |
| `secretRef` | reference for `CURSOR_API_KEY` | — |
| `permissionProfile` | `edit-and-shell` only, until the §4 write-behaviour Assumption is resolved. Shell is constrained by the sandbox. In API Key Mode, a generated `cli-config.json` adds `deny: ["Read(.env*)", "Write(**/*.key)"]`-style rules. A deny-all-shell rule for a future `edit-only` profile needs a validated token syntax (Assumption). | `edit-and-shell`, **only for execution-approved suites** |
| `sandbox.readBoundary` | `workspace` (API Key Mode, generated config) | `workspace` |
| `minimumVersion` | date version | unset (tested `2026.10.14-0f9edde`) |

Benchmark `execution.model` must use `provider: "cursor"` with a Cursor model id. The underlying vendor is recorded as reported, not inferred. In Local Subscription Mode the adapter cannot apply generated config without touching the user's global config. It never modifies `~/.cursor/*`. It relies on CLI flags only and records warning `user-cli-config-applies`.

## 8. Security concerns

See [SPEC-007](2026-10-14-security-and-privacy.md), [ADR-0007](../decisions/0007-local-runner-execution-and-isolation.md).

- **Shell access is effectively on.** `--force` auto-allows commands unless denied (U4). Cursor runs are therefore allowed only for execution-approved suites, always with `--sandbox enabled`. If the sandbox cannot be created, the run fails (`agent-sandbox-unavailable`) rather than continuing unsandboxed. The DirectiveBench environment is still recorded as `sandboxed: false` (`local-process`), with `agentSandbox: "cursor-sandbox"`.
- **Workspace trust.** `--trust` makes the CLI trust the fixture, including a fixture `.cursor/cli.json` that could **allow** commands, a fixture `.cursor/sandbox.json` that could open network, and MCP config. Fixture import flags `.cursor/cli.json`, `.cursor/sandbox.json`, `.cursor/mcp.json` and `mcp.json` as "changes agent permissions", and these require suite approval.
- **Ambient instructions (large surface).** With a real `HOME`, Cursor may load `~/.cursor/skills`, `~/.agents/skills`, **`~/.claude/skills` and `~/.codex/skills`** (compatibility loading, U9), the global `cli-config.json`/`sandbox.json`, and User Rules. **Team Rules** from the Cursor dashboard can be admin-enforced and cannot be disabled by users (U8). Whether the CLI applies User/Team Rules: **Assumption — requires validation**. Mitigation: API Key Mode isolates `HOME`. Team Rules are tied to the account and cannot be excluded in either mode, so every run records warning `account-rules-may-apply`. Subscription runs also record `ambient-user-config`.
- **HOME isolation vs auth.** Login storage is undocumented, so subscription mode cannot isolate `HOME`. API Key Mode is the recommended mode for reproducible benchmarks.
- **Secrets.** `CURSOR_API_KEY` only in env, never argv, never in the generated config file, and redacted from all output. The agent can read its env via shell (sandbox does not hide env: Assumption). This is a further reason to keep shell-enabled suites approved and to prefer short-lived/dedicated keys.
- **Network.** The CLI needs its endpoint (`api2.cursor.sh` by default). Sandbox network is blocked by default unless `sandbox.json` allows it (U10). The generated config in API Key Mode keeps it closed.
- **Data leaving the machine.** Prompt, files and artifact content go to Cursor and its model vendors. The UI states this.

## 9. Error handling

| Condition | Detection | Status | Code |
| --- | --- | --- | --- |
| Binary missing / `agent` is not Cursor | detection / version pattern | rejected before enqueue | `binary-not-found` |
| Not logged in / invalid key | non-zero exit, stderr; `status` | `agent-error` | `auth-missing` / `auth-invalid` |
| `apiKeySource` ≠ expected | `system/init` | `agent-error` (process killed) | `auth-mode-mismatch` |
| Unknown model / model not on plan | non-zero exit, stderr | `agent-error` | `model-not-found` (stderr patterns: Assumption) |
| Sandbox creation failure | stderr (AppArmor/user-namespace errors, U10) | `agent-error` | `agent-sandbox-unavailable` |
| Non-zero exit, no `result` event | U2 | `agent-error` | `agent-failed` (stderr tail, redacted) |
| Exit 0 but no `result` / malformed NDJSON | parser | `agent-error` | `output-parse-error` |
| Invalid flag (version drift) | non-zero exit, usage on stderr | `agent-error` | `cli-usage-error` |
| Corrupted generated config | CLI backs it up as `.bad` and recreates it (U7) | warning `cli-config-reset`; run continues but is flagged | — |
| Timeout / cancel | DirectiveBench | `timeout` / `cancelled` | — |

`result` is success-only, `subtype: "success"`, `is_error: false` (U2). A run is `completed` iff exit 0 and a `result` event was parsed.

## 10. Compatibility restrictions

- Platforms: macOS, Linux, WSL, Windows (U11). Linux sandbox needs kernel ≥ 6.2 with Landlock v3 and unprivileged user namespaces (U10). Tested on Linux with `2026.10.14-0f9edde` (L3).
- Versions are date-based and auto-updating (`update` command, L3). The version must be recorded per run. Auto-update between baseline and candidate would break comparability, so the adapter re-checks the version after each run and marks a mismatch as `not-comparable`.
- Plans/terms: usage counts against the Cursor account. Model availability depends on the plan (`models`). Terms review pending (§3.2).
- Docker/remote: only API Key Mode is conceivable. No credential forwarding ([SPEC-110 FR-110-33](2026-10-14-benchmark-execution.md)).

## 11. Test strategy

Per [SPEC-012](2026-10-14-testing-strategy.md). No paid or authenticated calls in CI.

- **Unit:** argv builder (always `-p --output-format stream-json --workspace --trust --force --sandbox enabled`; never `--api-key`/`--approve-mcps`/`--sandbox disabled`); env builder per mode; generated `cli-config.json` (valid JSON, `version: 1`, no secrets); version parser and `agent`-name validation; rejection of `auto` model.
- **Contract tests with recorded fixtures:** redacted NDJSON from manual runs in `packages/agent-adapters/test/fixtures/cursor/<version>/`: success with `writeToolCall`, a shell tool call (this resolves the shell-shape Assumption), failure without `result`, `apiKeySource` variants.
- **Fake CLI:** a Node script answering `--version`, `status --format json`, and `-p` streams, plus hang modes for timeout and cancel.
- **Opt-in live tests:** `DIRECTIVEBENCH_LIVE_TESTS=cursor`, run manually only. They must cover the open Assumptions: write behaviour with/without `--force`, skill loading in the CLI, stdin prompt, `--trust` necessity, sandbox fallback in print mode, and User/Team Rules application.
- **Drift check:** parse `cursor-agent --help` (read-only) for every flag used.

## 12. Acceptance criteria

- [ ] AC-1: Detection finds `cursor-agent` (or a validated `agent`) and parses `2026.10.14-0f9edde`. A non-Cursor `agent` binary is not reported as Cursor.
- [ ] AC-2: Readiness uses `status --format json` under the run env, without reading credential storage or persisting raw output.
- [ ] AC-3: API Key Mode: isolated `HOME`/`CURSOR_CONFIG_DIR`, key only in env, `init.apiKeySource == "env"` enforced. The key is absent from argv, DB, logs, traces and the generated config.
- [ ] AC-4: Subscription mode: no `CURSOR_API_KEY`, `init.apiKeySource == "login"` enforced, `ambient-user-config` and `account-rules-may-apply` warnings recorded. The user's `~/.cursor` is never modified.
- [ ] AC-5: Candidate installs follow §4.1. Skill runs carry the "skill loading unverified" warning until the Assumption is resolved.
- [ ] AC-6: Every run uses `--sandbox enabled` and is refused for non-approved suites. A sandbox failure yields `agent-sandbox-unavailable`, never an unsandboxed retry.
- [ ] AC-7: Recorded fixtures parse into trace events. `usage` is `null`. Failure streams without `result` map to §9 codes.
- [ ] AC-8: Timeout and cancel kill the process group within 10 s (fake CLI).
- [ ] AC-9: A version change between baseline and candidate marks the comparison `not-comparable`.

## 13. Current implementation status

- **Implemented in bootstrap** (code in `packages/agent-adapters/src/detection.ts`; the missing-executable path is verified by `mock.test.ts` "detectCliAgent"; detection of an installed `cursor-agent` is not covered by a test): detection descriptor `id: 'cursor'`, display name "Cursor Agent CLI", executable `cursor-agent`, `--version`, first output line stored, `auth: 'unknown'`, no credential files read.
- **Partially implemented:** version parsing (raw line only). There is no fallback to the `agent` binary name.
- **Not implemented:** readiness check, artifact installation, execution, stream parsing, generated config, error normalization, secret handling (blocked on [ADR-0008](../decisions/0008-secret-storage-and-authentication.md)), validation of the Assumptions listed in §4/§6/§8, terms review.
