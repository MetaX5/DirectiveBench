---
id: SPEC-203
title: Claude Code agent adapter
status: draft
created: 2026-10-14
updated: 2026-10-22
category: integration
related: [SPEC-118, SPEC-003, SPEC-007, SPEC-012, SPEC-102, SPEC-110, SPEC-112, SPEC-114, SPEC-115, SPEC-204, SPEC-205, SPEC-206, SPEC-211, ADR-0006, ADR-0007, ADR-0008, ADR-0009]
---

# SPEC-203 — Claude Code agent adapter

## 1. Purpose

Let DirectiveBench run benchmark cases with **Claude Code** (Anthropic's agentic coding CLI, binary `claude`) as an agent harness. The adapter's job is to measure how an installed artifact (skill, `CLAUDE.md`/`AGENTS.md` instruction, `.claude/rules` rule) changes Claude Code's behaviour in a RED/GREEN comparison ([SPEC-112](2026-10-14-red-green-evaluation.md)).

The adapter implements the `AgentAdapter` contract owned by `@directivebench/agent-adapters` ([SPEC-110 §8](2026-10-14-benchmark-execution.md#8-domain-entities-and-contracts), [ADR-0006](../decisions/0006-agent-adapters-vs-model-providers.md)). Calling the Anthropic Messages API directly is a different integration: a model provider ([SPEC-206](2026-10-14-integration-anthropic-api.md)) used by the future custom harness.

Out of scope: interactive sessions, Claude Code on the web / cloud sessions (`--cloud`), background sessions (`--bg`), IDE integrations, MCP server management.

### Evidence labels

Every statement about Claude Code is labelled:

- **Confirmed (source, date)** — read in official documentation or observed by running a read-only `--help`/`--version` command.
- **Assumption — requires validation** — believed but not verified; must be validated (and this spec updated) before code relies on it.

| Key | Source (all checked 2026-10-14) |
| --- | --- |
| C1 | https://code.claude.com/docs/en/headless |
| C2 | https://code.claude.com/docs/en/authentication |
| C3 | https://code.claude.com/docs/en/skills |
| C4 | https://code.claude.com/docs/en/memory |
| C5 | https://code.claude.com/docs/en/llm-gateway |
| C6 | https://code.claude.com/docs/en/agent-sdk/overview |
| C7 | https://code.claude.com/docs/en/agent-sdk/typescript |
| C8 | https://code.claude.com/docs/en/hooks (checked 2026-10-22) |
| C9 | https://code.claude.com/docs/en/cli-reference (checked 2026-10-22) |
| C10 | https://code.claude.com/docs/en/tools-reference (checked 2026-10-22) |
| C11 | https://code.claude.com/docs/en/permissions (checked 2026-10-22) |
| C12 | https://code.claude.com/docs/en/claude-directory (checked 2026-10-22) |
| L1 | Local `claude --version` → `2.1.296 (Claude Code)`; `claude --help`, `claude auth --help`, `claude auth status --help` (Linux, 2026-10-14) |
| L2 | Local `claude` 2.1.302 (Linux, 2026-10-22): `claude auth status` run logged in, and logged out with an empty `HOME`/`CLAUDE_CONFIG_DIR`, with and without a dummy `ANTHROPIC_API_KEY`; only the field names and non-personal values were recorded |

## 2. Official integration options

| Option | Description | Status | Use in DirectiveBench |
| --- | --- | --- | --- |
| **CLI print mode** `claude -p` | Non-interactive run; exits 0 on success, non-zero on failure; output `text`, `json` or `stream-json`. | Confirmed (C1, L1, 2026-10-14) | **Primary.** Uses the user's installed binary, so the measured version is the one detected. Works with every auth method the CLI supports. |
| **Claude Agent SDK** (TypeScript `@anthropic-ai/claude-agent-sdk`, Python) | Library that runs the Claude Code binary; `query()` with options such as `cwd`, `env`, `abortController`, `settingSources`, `permissionMode`, `allowedTools`, `model`, `maxTurns`, `pathToClaudeCodeExecutable`. | Confirmed (C6, C7, 2026-10-14) | **Secondary, API Key Mode only** (see §3 policy note). If used, `pathToClaudeCodeExecutable` must point at the detected binary, because the SDK otherwise resolves its own bundled binary (Confirmed, C7) and the measured version would differ from the detected one. |
| Messages API directly | Not Claude Code; no harness. | — | Model provider, [SPEC-206](2026-10-14-integration-anthropic-api.md). |

Decision for the first implementation: **CLI subprocess with `--output-format stream-json`**. No new runtime dependency, identical code path for both auth modes, and a parseable trace.

## 3. Authentication methods

DirectiveBench supports two modes ([ADR-0008](../decisions/0008-secret-storage-and-authentication.md)). The mode is chosen per agent configuration and recorded in run metadata and the comparability key.

### 3.1 Credential sources Claude Code itself supports

Confirmed (C2, 2026-10-14). Precedence when several are present:

1. Cloud provider credentials when `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` is set.
2. `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`; for LLM gateways/proxies).
3. `ANTHROPIC_API_KEY` (sent as `X-Api-Key`). **In `-p` mode the key is always used when present.**
4. `apiKeyHelper` script output (settings).
5. `CLAUDE_CODE_OAUTH_TOKEN` (one-year token from `claude setup-token`; requires a Pro, Max, Team or Enterprise plan).
6. Anthropic profile / Workload Identity Federation credentials.
7. Subscription OAuth credentials from `/login` (default for Pro, Max, Team, Enterprise).

Credential storage: Linux `~/.claude/.credentials.json` (mode 0600); macOS Keychain (fallback to the same file); Windows `%USERPROFILE%\.claude\.credentials.json`; relocated under `CLAUDE_CONFIG_DIR` when set. Confirmed (C2, 2026-10-14).

### 3.2 Local Subscription Mode

- DirectiveBench spawns the user's own, already logged-in `claude` binary on the user's machine and lets it use its own login. Nothing else.
- DirectiveBench **never** reads, parses, copies, exports or stores `~/.claude/.credentials.json`, Keychain entries or any other CLI session credential. It **never extracts browser cookies**. It never passes credentials to other tools.
- Because credentials live under the user's home/config directory, the agent process must run with the **real `HOME`** (and no `CLAUDE_CONFIG_DIR` override). This is an explicit, declared exception to the environment allowlist rule FR-110-42 ([SPEC-110](2026-10-14-benchmark-execution.md)). It applies **only to the agent process**. Setup and assertion commands keep the isolated `HOME`.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and the `CLAUDE_CODE_USE_*` variables must be **absent** from the agent environment. Otherwise they outrank the subscription login (precedence above) and the mode label would be wrong.
- Readiness: `claude auth status` (JSON output by default; `--text` for human output). Confirmed that the command and flags exist (L1, 2026-10-14). Confirmed on 2.1.302 (L2, 2026-10-22): it prints one JSON object with `loggedIn` (boolean), `authMethod` (`claude.ai` for a subscription login, `none` when logged out, `api_key` when `ANTHROPIC_API_KEY` is set), `apiProvider`, `analyticsDisabled`, `projectsDirectory`, `configDirectory` and, when logged in, the account's email, organisation id and name and subscription type; it exits 0 when logged in and 1 when not; it printed no secret and wrote nothing to its working directory, but it creates the configuration directory when it is missing. That it makes no paid call: **Assumption — requires validation**; how an expired login is reported: **Assumption — requires validation** (DirectiveBench maps the §9 text "Login expired" to `auth-expired`). DirectiveBench parses only the fields it needs (logged in yes/no, auth method), never persists, logs or displays the raw output, and runs the command with the environment allowlist (no `ANTHROPIC_*`, `CLAUDE_CODE_*` or `CLAUDE_CONFIG_DIR`, so the result describes the subscription login the agent will use) in an empty temporary directory (so no project settings of the caller's directory apply).
- **Policy note.** Anthropic states: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" (C6, 2026-10-14). DirectiveBench therefore never offers a claude.ai login flow, never embeds the Agent SDK with subscription credentials, and never collects `CLAUDE_CODE_OAUTH_TOKEN` values. Whether driving the user's own logged-in CLI for automated benchmarking is within the user's subscription terms: **Assumption — requires validation (terms review before release)**. The UI must state that subscription usage limits apply and that the run counts against the user's plan.
- Subscription credentials are **never uploaded to a shared server**. In a future self-hosted setup ([ADR-0009](../decisions/0009-self-hosted-readiness.md)), Local Subscription Mode is only available on a runner where the user personally logged in the CLI. The server only sees results.

### 3.3 API Key Mode

- The key is resolved from a secret reference (OS credential store, or an environment-variable fallback; [ADR-0008](../decisions/0008-secret-storage-and-authentication.md)). It is injected **only** into the agent subprocess environment as `ANTHROPIC_API_KEY`, never through argv. Confirmed that the CLI reads this variable (C1, C2, 2026-10-14).
- Variants:
  - **Anthropic API**: `ANTHROPIC_API_KEY`.
  - **LLM gateway / Anthropic-compatible endpoint**: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (Confirmed, C2, C5). Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" (C5). Pointing Claude Code at third-party Anthropic-compatible endpoints that serve other models (DeepSeek, GLM, Kimi; see [SPEC-211](2026-10-14-integration-custom-model-providers.md)) is therefore **unsupported by the vendor**. It may only be offered as an explicitly labelled "experimental, vendor-unsupported" configuration. Whether it works with any given endpoint: **Assumption — requires validation**.
  - **Amazon Bedrock / Google Vertex (Agent Platform) / Microsoft Foundry**: selected by `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` (Confirmed, C2). The cloud SDK credential variables (e.g. AWS profile/region) are provider-specific: **Assumption — requires validation** per provider. Not in the first implementation.
- Readiness: a secret reference resolves and is non-empty. Validating the key with a live call is opt-in only, never automatic, because it may cost money.

### 3.4 Not supported

- Cookie or session extraction, copying `.credentials.json`, reading the Keychain, `apiKeyHelper` scripts supplied by benchmark definitions.
- Storing `CLAUDE_CODE_OAUTH_TOKEN` (a subscription credential) in DirectiveBench: rejected pending the terms review in §3.2.

## 4. Capability requirements

Mapping to the `AgentAdapter` capability contract ([SPEC-110 §8](2026-10-14-benchmark-execution.md), [SPEC-003](2026-10-14-system-architecture.md)). Adapter id `claude-code`, display name "Claude Code".

| Capability | Mechanism | Evidence |
| --- | --- | --- |
| **Detection** | `claude` resolved on `PATH` (no shell); record the absolute path. | Confirmed binary name (L1, 2026-10-14) |
| **Version** | `claude --version` → `2.1.296 (Claude Code)`; parse `^(\d+\.\d+\.\d+)`. Also `-v`. | Confirmed (L1, 2026-10-14) |
| **Auth readiness** | Subscription: `claude auth status` (JSON default). API key: secret reference resolves. | Command confirmed (L1). Output schema: Assumption — requires validation |
| **Execution modes** | Non-interactive `-p/--print` only. | Confirmed (C1, L1) |
| **Model selection** | `--model <alias or full name>` (aliases such as `opus`, `sonnet`). The session model actually used (**execution model**) is read from the `system/init` event (`model`); `modelUsage` keys in the result can additionally contain auxiliary models used for internal tasks, so they are recorded but are not the execution model; every main-conversation assistant message must carry the execution model, and a skill's `model`/`context: fork` override (C3) is refused in S1 (§8). Execution models must be equal across all agent runs being compared ([SPEC-112](2026-10-14-red-green-evaluation.md) FR-112-04/08). `--fallback-model` must **never** be passed (it would silently change the model and break comparability). | Flag confirmed (L1, C7). `init.model` field: Confirmed (C1) |
| **Tool permissions** | `--permission-mode` (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`), `--allowedTools`/`--disallowedTools` (rule syntax e.g. `Bash(git diff *)`), `--tools` (restrict the built-in set), `--permission-prompts none` (deny anything that would prompt; v2.1.259+). | Confirmed (C1, L1) |
| **Working directory** | Spawn with `cwd` = workspace root. Do **not** use `--add-dir` or `--worktree`. | Confirmed (C3: project skills load from the start directory up to the repository root; C4: CLAUDE.md/AGENTS.md load from the working directory and above) |
| **Instructions/skills injection** | Candidate artifacts are written into the workspace (install convention §4.1). Never via `--append-system-prompt`, because that does not exercise discovery. | Confirmed discovery paths (C3, C4) |
| **Cancellation** | SIGINT ends the turn; SIGTERM → exit code 143 and terminates the process tree of running Bash commands. Escalation: SIGINT → 5 s → SIGTERM → 5 s → SIGKILL to the process group. | SIGTERM/143 and SIGINT confirmed (C1). Grace periods: DirectiveBench choice |
| **Timeouts** | Enforced by DirectiveBench (case `timeoutSeconds`), followed by cancellation. Optional cost cap `--max-budget-usd` (print mode only; result subtype `error_max_budget_usd`). | Confirmed (L1, C7) |
| **Structured output** | `--output-format stream-json --verbose` (NDJSON). The last line is a `result` message. `--json-schema` exists but is not used (benchmarks verify files, not answers). | Confirmed (C1). That `--verbose` is *required* with `stream-json`: Assumption — requires validation (all doc examples include it) |
| **Traces** | Map `system/init` (model, tools, MCP servers, plugins, `plugin_errors`, `mcp_server_errors`), `assistant`/`user` messages (`tool_use`/`tool_result` blocks), `system/api_retry`, `permission_denied` system messages and `result` to `TraceEvent`s. | Confirmed (C1) |
| **File modification tracking** | Authoritative: DirectiveBench before/after manifest diff ([SPEC-110](2026-10-14-benchmark-execution.md)). Supplementary: `Edit`/`Write` `tool_use` blocks in the trace. Writes outside the workspace are not detectable on `local-process`. | Engine behaviour: SPEC-110. Tool names `Edit`/`Write`: Assumption — requires validation |
| **Error normalization** | Exit code + `result.subtype` (`success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`), `result.is_error`, `errors[]`, `api_retry.error` categories (`authentication_failed`, `billing_error`, `rate_limit`, `overloaded`, `model_not_found`, …). See §9. | Confirmed (C1, C7) |
| **Usage reporting** | `result.total_cost_usd`, `result.usage`, `result.modelUsage`, `num_turns`, `duration_ms`, `duration_api_ms`. Cost is a client-side estimate (C1) and is labelled "estimated". In Local Subscription Mode, cost is reported as "n/a (subscription)" and tokens only. | Confirmed (C1, C7) |
| **Session hygiene** | `--no-session-persistence` (print only), so runs don't write resumable sessions into the user's `~/.claude`. | Confirmed (L1) |

### 4.1 Artifact install convention (candidate variant only)

| Artifact format ([SPEC-102](2026-10-14-artifact-discovery.md)) | Installed at | Evidence |
| --- | --- | --- |
| `skill-md` | `.claude/skills/<slug>/SKILL.md` (+ supporting files, preserved relative layout) | Confirmed project skill path (C3, 2026-10-14) |
| `claude-md` | `./CLAUDE.md` | Confirmed (C4) |
| `agents-md` | `./AGENTS.md`. Claude Code reads `AGENTS.md` directly only from v2.1.277 and only when no `CLAUDE.md`/`.claude/CLAUDE.md`/`CLAUDE.local.md` exists in the working directory or above. For older versions, or if the fixture contains a `CLAUDE.md`, also write a `CLAUDE.md` containing `@AGENTS.md` (documented import), and record it as an install note. | Confirmed (C4) |
| `claude-rule` | `.claude/rules/<name>.md` | Confirmed rules directory (C4) |
| other formats | Not installable; the run is rejected before execution as "artifact format not compatible with adapter claude-code". | DirectiveBench rule |

- Instruction files (`CLAUDE.md`, `AGENTS.md`) that already exist in the fixture are **appended to**, separated by a blank line. This matches the Mock Agent (`packages/agent-adapters/src/mock.ts`). For skills and rules, an existing target path → `infrastructure-error` (`artifact-install-conflict`). Files are written with exclusive-create and path containment (`writeArtifactFiles`).
- `.agents/skills/` is **not** documented as a Claude Code skill location (C3 does not mention it). Do not use it for this adapter.
- The baseline variant receives nothing, except in an A/B run ([SPEC-118](2026-10-22-benchmark-own-skills-s1.md) FR-118-11), where it receives the baseline version of the same artifact through exactly this convention. Both variants get identical flags, model, permission profile and environment.

### 4.2 Contract mapping and required extensions

The bootstrap contract is `packages/agent-adapters/src/contract.ts`. Declared `AgentCapabilities` once execution exists: `execution: true`, `headless: true`, `modelSelection: true`, `artifactInstallation: true`, `structuredOutput: true`, `usageReporting: true`, `deterministic: false`. Until then, the detection-only descriptor declares `execution: false`. `detect()` returns `auth: 'ready'` when at least one auth mode is ready and `'missing'` otherwise (including when `claude` is not installed), with the per-mode results in `readiness` (§13).

Real CLI adapters need these **proposed extensions**. They are shared by [SPEC-204](2026-10-14-integration-openai-codex.md) and [SPEC-205](2026-10-14-integration-cursor.md), and must be folded into [SPEC-110 §8](2026-10-14-benchmark-execution.md) when approved:

- `AgentRunRequest.auth: { mode: 'subscription' | 'api-key' | 'gateway'; secretRef?: SecretRef }` (`SecretRef` = `{ source: 'keychain' | 'env'; name: string }`, [SPEC-115 FR-115-30](2026-10-14-settings-and-configuration.md)), resolved by the runner and never serialized with the secret value.
- `AgentRunRequest.options` (already present: `agentOptions[adapterId]`) carries the validated permission profile.
- `AgentRunResult.errorCode?: string` (codes in §9), `warnings: string[]`, `metadata: { adapterVersion, authMode, isolationProfile, permissionProfile, requestedModel, executionModel, reportedModels[], flagsHash }` and, for `skill-md` artifacts, `skillActivation: { loaded, invoked, invocations, otherSkills[] }` derived from `system/init` and `Skill` tool calls ([SPEC-118](2026-10-22-benchmark-own-skills-s1.md) FR-118-04/09).
- New `TraceEvent` variants: `{ type: 'tool-call'; tool: string; input?: unknown; callId: string }`, `{ type: 'tool-result'; callId: string; ok: boolean; output?: string }` (truncated, redacted), `{ type: 'permission-denied'; tool: string }`, `{ type: 'retry'; attempt: number; category: string }`, `{ type: 'usage'; … }`.
- `AgentUsage` gains `cachedInputTokens?`, `reasoningTokens?`, `costIsEstimate?: boolean`.

## 5. Architecture

Code location (future): `packages/agent-adapters/src/claude-code/` with `detect.ts` (existing detection descriptor), `argv.ts`, `env.ts`, `install.ts`, `stream-parser.ts`, `normalize.ts`. Pure functions (argv/env builders, parser, normalizer) are separated from the process spawner so they can be contract-tested with fixtures.

```mermaid
sequenceDiagram
  participant E as Benchmark engine
  participant A as ClaudeCodeAdapter
  participant S as Secret resolver (ADR-0008)
  participant P as claude -p (child process)
  E->>A: installArtifact(workspace, version) [candidate only]
  E->>A: run({prompt, workspace, model, limits, signal, authMode})
  A->>A: validate capabilities, version >= minimum, compatible auth/model
  alt API Key Mode
    A->>S: resolve secret ref
    S-->>A: key (memory only)
    A->>A: env = allowlist + isolated HOME/CLAUDE_CONFIG_DIR + ANTHROPIC_API_KEY
  else Local Subscription Mode
    A->>A: env = allowlist + real HOME (declared exception), no ANTHROPIC_* vars
  end
  A->>P: spawn(argv, {cwd: workspace, shell: false, detached process group}), prompt on stdin
  P-->>A: NDJSON events (stdout), diagnostics (stderr)
  A->>A: parse → TraceEvent[], usage, model used; redact
  alt signal aborted / timeout
    A->>P: SIGINT → SIGTERM → SIGKILL (process group)
  end
  P-->>A: exit code
  A-->>E: AdapterRunOutput {status, error?, trace, usage?, warnings, metadata}
```

The prompt is passed on **stdin** (C1: print mode reads stdin; piped stdin is capped at 10 MB), not as an argv element. This avoids argv length limits and keeps prompts out of process listings.

Recorded run metadata (added to `EnvironmentMetadata`/comparability key per [ADR-0006](../decisions/0006-agent-adapters-vs-model-providers.md)): adapter version, auth mode (`subscription` | `api-key` | `gateway`), isolation profile (`isolated` | `user-profile`), requested model, reported model(s), permission profile, flags hash.

## 6. Relevant API or CLI interfaces

Canonical invocation (per agent run):

```text
claude -p
  --output-format stream-json --verbose
  --model <model>                        # omitted when the benchmark sets no model
  --tools <profile list>                 # see §7 (built-in tool set)
  --permission-mode dontAsk
  --allowedTools <profile list>          # see §7
  --permission-prompts none              # v2.1.259+
  --no-session-persistence
  --strict-mcp-config                    # load no MCP servers (no --mcp-config given)
  --settings '{"disableSkillShellExecution":true,"permissions":{"blockReadsOutsideWorkingDirectories":true}}'   # see §7, §8
  [--setting-sources project,local]      # Local Subscription Mode only, see §8
  [--max-budget-usd <n>]                 # API Key Mode, optional
  (prompt on stdin)
```

| Interface | Notes | Evidence |
| --- | --- | --- |
| `-p, --print` | Non-interactive. **Skips the workspace trust dialog**; project `.claude/settings.json` hooks and `.mcp.json` servers run without prompting (unless `--bare`). | Confirmed (C1, L1) |
| `--output-format text\|json\|stream-json` | `json` gives one result object; `stream-json` gives NDJSON whose last line is `result`. | Confirmed (C1, L1) |
| `--include-partial-messages` | Token deltas. Not used (trace size). | Confirmed (L1) |
| `--bare` | Skips hooks, skills, plugins, MCP, auto memory and **CLAUDE.md auto-discovery**; auth strictly `ANTHROPIC_API_KEY`/`apiKeyHelper`. **Not usable for candidate runs**, because it disables the discovery being measured (C1: in bare mode Claude "doesn't get the list of available skills"). May be used for an optional "API smoke check". | Confirmed (C1, L1) |
| `--safe-mode`, `--disable-slash-commands` | Disable customizations / all skills. Not usable for the same reason. | Confirmed (L1) |
| `--setting-sources <user,project,local>` | Selects the settings sources to load. Whether excluding `user` also excludes `~/.claude/CLAUDE.md`, `~/.claude/skills` and `~/.claude/rules`: **Assumption — requires validation** (C4 confirms that excluding `project`/`local` skips project rules and `CLAUDE.local.md`). | Flag confirmed (L1) |
| `--strict-mcp-config` | Only MCP servers from `--mcp-config`. | Confirmed (L1) |
| `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--tools`, `--permission-prompts` | See §4. `dontAsk` denies everything that would prompt, except actions that need no approval in Manual mode (reads in working dirs, the read-only command set) and actions covered by allow rules. | Confirmed (C1, L1) |
| `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `bypassPermissions` | **Forbidden** on `local-process`. The adapter rejects such configuration. | Flags confirmed (L1) |
| `claude auth status [--json\|--text]` | Readiness check. | Confirmed (L1) |
| Result message fields | `type:"result"`, `subtype`, `is_error`, `duration_ms`, `duration_api_ms`, `num_turns`, `result`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `errors` (error subtypes), `session_id`. | Confirmed (C7, 2026-10-14) |
| `system/api_retry` fields | `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` (category). | Confirmed (C1) |
| Env `CLAUDE_CONFIG_DIR` | Relocates config, settings, sessions and credentials. | Confirmed (C2) |
| Env `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | Caps the idle wait for background work after the turn (default 10 min). Set it ≤ the remaining timeout. | Confirmed (C1) |

## 7. Configuration

Per agent configuration (stored in `config.json` / DB without secrets; [SPEC-115](2026-10-14-settings-and-configuration.md)):

| Setting | Values | Default |
| --- | --- | --- |
| `binaryPath` | absolute path override | auto (PATH) |
| `authMode` | `subscription` \| `api-key` \| `gateway` | `subscription` (maintainer decision for S1, [SPEC-118](2026-10-22-benchmark-own-skills-s1.md); previously "none: the user must choose explicitly"). Every run shows the mode, and subscription runs carry `ambient-user-config` (§8). `gateway` is not offered in S1. |
| `secretRef` | reference to `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (api-key/gateway) | — (S1: only `{ source: 'env', name: 'ANTHROPIC_API_KEY' }` from the CLI environment, until [ADR-0008](../decisions/0008-secret-storage-and-authentication.md) keychain storage exists) |
| `baseUrl` | gateway URL (gateway mode) | — |
| `permissionProfile` | `edit-only` → `--tools "Read,Edit,Write,Glob,Grep" --permission-mode dontAsk --allowedTools "Edit(/**)"`. `--tools` removes `Bash` entirely, because under `dontAsk` the read-only command set would otherwise still run (C1). **No bare file-tool allow rule:** a bare `Read`/`Edit`/`Write` rule approves every use wherever the path is, so it would let the agent read host files into the model and write outside the workspace (C11). `Edit(/**)` is anchored at the primary working directory (the workspace) for CLI rules, `Write` is checked against `Edit` path rules, reads inside the working directory need no approval, and `blockReadsOutsideWorkingDirectories` (§6) makes the file tools refuse outside reads in every mode (C11). `edit-and-shell` → adds `Bash` to `--tools` and `--allowedTools` (only for execution-approved suites; shell commands are not confined, C11). **Per artifact type:** for `skill-md` both profiles add `Skill` to `--tools` and `Skill(<name>)`, `Skill(<name> *)` to `--allowedTools`, where `<name>` is the installed skill's resolved name; `Skill` is a built-in tool that requires permission (C10), so without this the installed skill could never be invoked, and under `dontAsk` every other skill is denied (C3). Instruction types (`claude-md`, `agents-md`, `claude-rule`) load without `Skill` and get the profile without it. | `edit-only` |
| `maxBudgetUsd` | number (API Key Mode) | unset |
| `minimumVersion` | semver | `2.1.259` (needed for `--permission-prompts`). Proposed; tested with 2.1.296 |

Benchmark `execution.model` (`{provider: "anthropic", model}`) maps to `--model`. A provider other than `anthropic` (or a cloud/gateway provider explicitly configured) is rejected before enqueue ([ADR-0006](../decisions/0006-agent-adapters-vs-model-providers.md)). Exact tool names in the profiles (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`, `Skill`): Confirmed (C10, 2026-10-22); `Glob` and `Grep` are absent from the default set on macOS/Linux/WSL and are enabled by naming them in `--tools` (C9).

## 8. Security concerns

Baseline rules: [SPEC-007](2026-10-14-security-and-privacy.md), [ADR-0007](../decisions/0007-local-runner-execution-and-isolation.md), [SPEC-110 command rules](2026-10-14-benchmark-execution.md).

- **Not sandboxed.** On `local-process`, Claude Code runs with the user's OS permissions. The UI shows "Not sandboxed". Claude Code's own permission system limits which tools run without approval, but it is not an OS isolation boundary. Shell access (`Bash`) is off by default (`edit-only` profile).
- **Repository-controlled code under `-p`.** Print mode skips the trust dialog, so fixture-provided `.claude/settings.json` hooks and `.mcp.json` servers would run (C1). Mitigations: `--strict-mcp-config`, and in S1 fixtures and overlays may contain **no** Claude Code configuration at any depth (`.claude`, `.claude-plugin`, `.mcp.json`, `CLAUDE.local.md`, `.worktreeinclude`, `.claude.json`; C12), not even with execution approval: local `permissions.allow` or `additionalDirectories` merge with the CLI's allow list and would widen the profile (C11). The workspace is re-checked before spawn, so setup commands cannot add configuration ([SPEC-118](2026-10-22-benchmark-own-skills-s1.md) FR-118-06).
- **Host files through memory imports.** `@path` imports in memory files are expanded at launch, recursively up to four hops, with relative, absolute and `~` paths (C4), so a chain of workspace files can load a host file into context; external imports load in `-p` only if approved for the project before (C4), which DirectiveBench does not rely on. S1 scans every workspace file for import tokens and refuses existing outside targets and outward symlinks or hard links, at plan time and before every spawn, with no exemption for artifact files (SPEC-118 FR-118-27). Disabling hooks through a `--settings` override: `--settings '{"disableAllHooks": true}'` turns hooks off for one run (Confirmed for settings-file hooks, C8); whether it also covers skill-frontmatter hooks is not documented (C8). It is not needed in S1, because fixtures cannot contain hooks and artifacts with hooks are refused.
- **Model overrides in skills and commands.** A skill's or legacy command's `model` frontmatter switches the model for the rest of the turn — in `-p`, the whole run — and `context: fork` runs it in a subagent with its own model (C3). S1 refuses non-`inherit` `model` and `context: fork` in artifact versions, and fixtures cannot contain skills or commands (SPEC-118 FR-118-06/26), and checks that every main-conversation assistant message carries the execution model (field: **Assumption — requires validation**).
- **Skill-equivalent locations.** Legacy commands (`.claude/commands/**/*.md`) accept the same frontmatter as skills except `name` and `paths`, and `.claude/skills/` below the start directory load the first time Claude reads or edits a file there (C3). S1 therefore refuses any `.claude` directory at any depth in fixtures and artifact bundles (SPEC-118 FR-118-06/26).
- **Code embedded in skills.** A skill can execute code without the `Bash` tool, even in an untrusted `-p` run: frontmatter `hooks` are registered when the skill is invoked and run for the rest of the session (C8); `` !`command` `` placeholders run before the skill content reaches the model, checked only against permission rules (C3); frontmatter `allowed-tools` grants tools during the invoking turn (C3), and a grant of a tool already in the profile can still widen it (bare `Skill`, `Skill(other)`, bare `Edit`). An artifact version (candidate or baseline) with any of these (any non-empty `allowed-tools`), or bundling a plugin manifest, `.mcp.json`, `hooks.json` or settings file, is refused in S1 ([SPEC-118](2026-10-22-benchmark-own-skills-s1.md) FR-118-26); fixtures cannot contain skills, commands or subagents at all (FR-118-06). The argv also sets `disableSkillShellExecution` (C3: replaces each placeholder with a "disabled by policy" note for project skills; observed effect under `--setting-sources`: **Assumption — requires validation**). Whether `allowed-tools` can re-add a tool removed by `--tools`: **Assumption — requires validation** (the inspection refuses such skills either way).
- **Ambient user-level instructions.** Without isolation, Claude Code loads `~/.claude/CLAUDE.md`, `~/.claude/rules/`, `~/.claude/skills/` (including claude.ai-synced skills under `~/.claude/skills/synced/`), user settings/hooks/plugins, and the managed policy files (`/etc/claude-code/CLAUDE.md`, managed skills) (Confirmed, C3, C4).
  - API Key Mode: `HOME` and `CLAUDE_CONFIG_DIR` point to a run-local temp directory, so user-level config is excluded. Managed policy files cannot be excluded (C4). If they exist, the adapter records warning `managed-policy-present`.
  - Local Subscription Mode: user-level config is loaded (real `HOME` is needed for auth). The adapter passes `--setting-sources project,local` (excludes user settings/hooks) and records warning `ambient-user-config` on every run. Results are labelled "may include user-level instructions" and are never compared across machines.
- **HOME isolation vs auth trade-off** (summary): isolated `HOME` → reproducible, needs API Key Mode; real `HOME` → subscription works, ambient config leaks in. This is recorded as `isolationProfile` in the comparability key.
- **Network.** Claude Code needs network access to its API endpoint. Tool-level network (`WebFetch`, `WebSearch`) is excluded by the permission profiles. `local-process` cannot block outbound traffic from shell commands.
- **Secrets.** API keys only in the subprocess env, never argv, DB, logs or traces. Redact stdout/stderr/trace with `@directivebench/core` redaction plus the exact resolved key value. Never log the env object. The agent can read its own env through Bash, which is another reason Bash is off by default.
- **Data leaving the machine.** Prompt, fixture content read by the agent, and the artifact are sent to Anthropic (or the configured gateway/cloud). The UI states this before the first real run.
- **Transcripts.** `--no-session-persistence` keeps benchmark transcripts out of the user's `~/.claude`.

## 9. Error handling

| Condition | Detection | Execution status | Error code |
| --- | --- | --- | --- |
| Binary not on PATH | detection | run rejected before enqueue | `binary-not-found` |
| Version below minimum / unparsable | `--version` | rejected before enqueue | `version-unsupported` |
| Not logged in / expired login | `auth status`; result text such as `Login expired · Please run /login` | `agent-error` | `auth-missing` / `auth-expired` |
| Invalid flag (version drift) | non-zero exit before run, error on stderr (C1) | `agent-error` | `cli-usage-error` |
| API failure | `system/api_retry` `error` category; final non-zero exit / `is_error: true` | `agent-error` | `authentication_failed`→`auth-invalid`, `billing_error`→`billing`, `rate_limit`/`overloaded`→`rate-limited`, `model_not_found`→`model-not-found`, other→`provider-error` |
| `error_max_budget_usd` | result subtype | `agent-error` | `budget-exceeded` |
| `error_max_turns` / `error_during_execution` | result subtype | `agent-error` | `agent-failed` (message from `errors[]`) |
| No `result` line / malformed NDJSON | parser | `agent-error` | `output-parse-error` (keep raw tail, redacted) |
| Installed skill missing from `system/init` (`Skill` tool absent, or the skill not listed) | parser | `infrastructure-error` | `artifact-not-loaded` |
| Artifact version contains executable customizations | inspection before enqueue | run rejected before enqueue | `artifact-executes-code` |
| Timeout | DirectiveBench timer | `timeout` | — |
| Cancel | `AbortSignal` | `cancelled` | — (exit 143 after SIGTERM expected) |
| Spawn failure (EACCES, ENOENT after detection) | spawn error | `infrastructure-error` | `spawn-failed` |

Tool denials (`permission_denials`) are **not** errors. They are recorded in the trace and surfaced as a warning, because they are part of the measured behaviour. A run is `completed` if the process exits 0 with `subtype: "success"`, even if `is_error` is true. In that case it is recorded as warning `agent-reported-error`. **Assumption — requires validation:** the exact semantics of `is_error: true` with `subtype: "success"`.

## 10. Compatibility restrictions

- Platforms: Linux and macOS first ([SPEC-110](2026-10-14-benchmark-execution.md) §7). Windows credential path is documented (C2), but process-tree kill on Windows is an Assumption — requires validation.
- Versions: tested 2.1.296 (L1). Proposed minimum 2.1.259. Features gated by version: `AGENTS.md` direct read ≥ 2.1.277 (C4), full `--bare` limits ≥ 2.1.286 (C1). Record the version on every run. Version changes make results non-comparable (comparability key).
- Plans: subscription mode requires a plan that includes Claude Code (Pro, Max, Team, Enterprise) (C2). Usage limits apply.
- Terms: Agent SDK + claude.ai login in third-party products is not allowed without approval (C6). Agent SDK usage is governed by Anthropic's Commercial Terms (C6). Branding: do not call the DirectiveBench adapter "Claude Code Agent" in a way that implies an Anthropic product. Display "Claude Code (your installed CLI)".
- Docker / remote runners: no credential forwarding ([SPEC-110 FR-110-33](2026-10-14-benchmark-execution.md)). Inside a container only API Key Mode is possible, with the key provided to that environment.

## 11. Test strategy

Per [SPEC-012](2026-10-14-testing-strategy.md). **No paid or authenticated calls in CI.**

- **Unit:** argv builder (snapshot per permission profile/auth mode; asserts no secret in argv, no `--fallback-model`, no dangerous flags); env builder (API Key Mode isolates `HOME`/`CLAUDE_CONFIG_DIR`; subscription mode strips `ANTHROPIC_*`/`CLAUDE_CODE_USE_*`); version parser (`2.1.296 (Claude Code)`); install convention table.
- **Contract tests with recorded fixtures:** redacted NDJSON transcripts captured manually from real runs, stored under `packages/agent-adapters/test/fixtures/claude-code/<cliVersion>/` (success with edits, permission denial, max budget, auth failure, api_retry, malformed/truncated stream). Assert parser → `TraceEvent[]`, usage and normalized errors.
- **Fake CLI:** a Node script exposed as `claude` on a test `PATH`, emulating `--version`, `auth status` and `-p` streaming, plus hang/ignore-SIGINT modes. Covers spawn, stdin prompt, timeout escalation, cancellation and process-group cleanup.
- **Opt-in live tests:** `DIRECTIVEBENCH_LIVE_TESTS=claude-code` plus explicit auth mode. Run manually by a developer, never in CI. They use a tiny fixture and `--max-budget-usd` in API Key Mode, and the **exact production argv** of §6/§7. They prove discovery and invocation: a planted skill appears in `system/init`, is invoked through `Skill` and its marker instruction is followed; another skill is denied; a `CLAUDE.md` marker is followed. They record the field names this spec marks as assumptions and refresh the recorded fixtures (after redaction review).
- **Drift check (manual or CI only when the binary is present):** parse `claude --help` and assert every flag the adapter uses still exists. Read-only, no auth.

## 12. Acceptance criteria

- [ ] AC-1: Detection reports `installed`, absolute `path` and parsed `version` for `claude`, and `installed: false` (no crash) when absent.
- [ ] AC-2: Readiness distinguishes "logged in (subscription)", "API key configured", and "not ready" without reading any credential file, and without persisting raw `auth status` output.
- [ ] AC-3: In API Key Mode the agent process has `HOME` and `CLAUDE_CONFIG_DIR` inside the run temp dir and the key only in env. A test proves the key never appears in argv, DB rows, logs or traces.
- [ ] AC-4: In Local Subscription Mode no `ANTHROPIC_*`/`CLAUDE_CODE_USE_*`/`CLAUDE_CODE_OAUTH_TOKEN` variable reaches the agent, and every run records the `ambient-user-config` warning.
- [ ] AC-5: The candidate install places `skill-md` under `.claude/skills/<slug>/`, `claude-md` at `CLAUDE.md`, `claude-rule` under `.claude/rules/`, `agents-md` per §4.1. The baseline workspace contains none of them, or in an A/B run exactly the baseline version installed the same way ([SPEC-118](2026-10-22-benchmark-own-skills-s1.md)).
- [ ] AC-6: Baseline and candidate runs of one case use byte-identical argv and identical env keys. Only the workspace contents differ (no artifact vs candidate, or baseline version vs candidate version).
- [ ] AC-7: A recorded stream-json fixture is parsed into trace events, reported model, token usage and estimated cost. Malformed input yields `output-parse-error`, not a crash.
- [ ] AC-8: Cancellation and timeout terminate the whole process group within 10 s (fake CLI test) and yield `cancelled` / `timeout`.
- [ ] AC-9: Configurations requesting `bypassPermissions`, `--dangerously-skip-permissions`, `--bare` for candidate runs, or `--fallback-model` are rejected with a clear message.
- [ ] AC-10: Error fixtures map to the codes in §9.
- [ ] AC-11: The `skill-md` argv allows `Skill` only for the installed skill and instruction types get no `Skill`; recorded streams yield `skillActivation` (loaded, invoked, denied other skills), and the opt-in live test proves discovery and invocation with the production argv ([SPEC-118](2026-10-22-benchmark-own-skills-s1.md) FR-118-08/09).
- [ ] AC-12: A candidate or baseline skill with frontmatter `hooks`, a `` !` `` placeholder or any non-empty `allowed-tools` (including bare `Skill`, `Skill(other-name)` and bare `Edit`) is refused before `claude` starts (SPEC-118 FR-118-26).
- [ ] AC-13: `executionModel` is read from `system/init`; agent runs with different execution models are `not-comparable`; auxiliary `modelUsage` models are recorded and do not affect comparability (SPEC-118 FR-118-04).
- [ ] AC-14: The profiles contain no bare `Read`/`Edit`/`Write`/`Glob`/`Grep` allow rule, allow edits only through `Edit(/**)` and set `blockReadsOutsideWorkingDirectories`; the opt-in live test proves that reads and edits/writes outside the workspace are denied (SPEC-118 FR-118-07).

## 13. Current implementation status

The first execution slice (S1) is specified in [SPEC-118](2026-10-22-benchmark-own-skills-s1.md): print mode with `stream-json`, both auth modes (subscription default; API key from the environment only), the `edit-only`/`edit-and-shell` profiles in their per-artifact-type form (`Skill` for skills), skill-activation recording, refusal of executable skill customizations, the execution-model comparability rule, install convention §4.1 for candidate and A/B baseline, the §4.2 extensions it needs, cancellation, parsing, usage and §9 errors. The Agent SDK option, gateway and cloud-provider modes stay out of S1. The terms review of §3.2 must be recorded here before a release ships subscription mode as the default.

- **Implemented in bootstrap** (code in `packages/agent-adapters/src/detection.ts`, verified by `packages/agent-adapters/test/detection.test.ts`): a detection descriptor (`id: 'claude-code'`, executable `claude`, `--version`). It locates the binary on `PATH` without a shell, runs `--version` with a 5 s timeout (`AGENT_VERSION_TIMEOUT_MS`), stores the first output line, and never reads credential files. The results are shown on the Agent Connections page and by `directivebench doctor`.
- **Implemented — readiness (issue #102, SPEC-118 Phase 3 step 4; verified on 2026-10-22 by `packages/agent-adapters/test/claude-code-readiness.test.ts`, `probe.test.ts`, `detection.test.ts`, `apps/cli/test/doctor.test.ts` and the Playwright test "Claude Code readiness is shown per auth mode", all with a fake `claude`, and read-only against the real `claude` 2.1.302 by the built CLI's `doctor` and Agent Connections page):** AC-1 (installed, absolute path, version, `installed: false` without a crash) and AC-2. `checkClaudeCodeReadiness(mode)` (`claude-code-readiness.ts`) parses the version (`^(\d+\.\d+\.\d+)`) and requires ≥ `minimumVersion` 2.1.259 (`version-unsupported`); subscription mode runs `claude auth status --json` (10 s `CLAUDE_AUTH_STATUS_TIMEOUT_MS`, 64 KiB output cap) and keeps only `loggedIn`/`authMethod` (§3.2; `auth-missing`, `auth-expired`, fail closed on anything unreadable); api-key mode checks that `ANTHROPIC_API_KEY` in the CLI environment is non-empty and never reads or shows its value. Probes (`probe.ts`) run argv-only, with an environment allowlist plus `NO_COLOR=1`, in an empty temporary directory, killed with `SIGKILL` on timeout. `detect()` reports `ready`/`missing` with per-mode `readiness`; `doctor` prints one line per mode (warning only when no mode is ready) and the Agent Connections page shows them. Not verified: an expired subscription login against the real CLI (no expired login was available), and Windows.
- **Not implemented:** use of the readiness check before a run (SPEC-118 FR-118-35/39, `benchmark run`), artifact installation, execution (there is no `claude-code` `AgentAdapter`; `createExecutableAdapters()` contains only `mock`, so a suite with `agent: claude-code` fails with "cannot execute benchmarks in this build", [SPEC-110](2026-10-14-benchmark-execution.md)), stream parsing, usage reporting, error normalization, secret resolution (blocked on [ADR-0008](../decisions/0008-secret-storage-and-authentication.md) acceptance), Agent SDK option, gateway/cloud-provider modes, terms review (§3.2).
