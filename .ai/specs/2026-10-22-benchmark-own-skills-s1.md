---
id: SPEC-118
title: Benchmark own skills with Claude Code against registry artifacts (S1)
status: draft
created: 2026-10-22
updated: 2026-10-22
category: feature
related: [SPEC-203, SPEC-107, SPEC-108, SPEC-110, SPEC-111, SPEC-112, SPEC-113, SPEC-114, SPEC-009, SPEC-013, SPEC-103, ADR-0005, ADR-0006, ADR-0007, ADR-0008]
---

# SPEC-118 — Benchmark own skills with Claude Code against registry artifacts (S1)

## 1. Summary

A skill author who keeps revising a skill can, after this slice, run one fixed benchmark suite
of their own against a **scanned registry artifact version** with **Claude Code** (their
installed `claude` CLI, headless) and compare it either with **no artifact** or with **another
version of the same artifact** (A/B). The suite lives as a folder on disk (YAML + fixture files),
is scaffolded by `directivebench benchmark init --artifact <id>`, run by
`directivebench benchmark run <suite> --artifact <id>`, graded by deterministic assertions
(including three new document-oriented ones), and its results are kept per artifact version and
shown read-only in the web UI. This is future behaviour; today only the mock agent executes.

This spec defines the slice and its new contracts. It does not repeat the specs it builds on;
§17 lists the sections of those specs that this slice changes, and those sections were updated in
the same change.

## 2. Motivation and problem statement

- The maintainer revises skills and instructions for internal tools and client projects. Each
  revision is tried on a different prompt or task, so results are not comparable and "did this
  change help?" has no reliable answer; version-against-version checks are not done at all
  ([brief](briefs/2026-10-22-benchmark-own-skills-s1.md), product brief Problems).
- After using 0.1.1-rc.0 on 2026-10-22 the maintainer said the preview is useful but the
  product's main job is benchmarking skills and building one's own benchmarks; there is no other
  use today. This answers the D07 value checkpoint early and is the basis of decision
  [D08](research/decisions/D08-comparison-before-the-rest-of-the-registry.md).
- Today the engine runs only the deterministic mock agent (`createExecutableAdapters()` contains
  only `mock`), suites are imported YAML bound to bundled example artifacts, there is no
  `benchmark` CLI command, and scanned registry artifacts cannot be benchmarked
  ([SPEC-203 §13](2026-10-14-integration-claude-code.md#13-current-implementation-status),
  [SPEC-009 §2](2026-10-14-cli-architecture.md)).

The work is **generic**: users build their own scenarios (fixtures, prompt), requirements and
grading. A project-estimation skill whose output is a Markdown file with prose and tables is the
reference scenario used to check that the design is sufficient — not a target to special-case.

## 3. Goals

- G1: Run a user's suite against any scanned artifact version with Claude Code, from the CLI,
  under the RED/GREEN protocol of [SPEC-112](2026-10-14-red-green-evaluation.md).
- G2: Baseline = no artifact (existing semantics) **or** another version of the same artifact
  (A/B), chosen per run.
- G3: Scaffold a suite folder bound to an artifact, which the user edits and versions in git.
- G4: Grade documents deterministically: required Markdown headings, required phrases or regular
  expressions, and a number in a Markdown table cell within a range — in addition to the existing
  `command`, `file-exists`, `file-contains` and `changed-files` assertions.
- G5: Keep results per artifact version with the baseline, auth mode and isolation profile
  visible, and never compare runs whose conditions differ.
- G6: Be honest about cost, ambient configuration and the lack of a sandbox before and after
  every run.

## 4. Non-goals

- Builder UI, editing scenarios in the UI, and running from the UI (S2, [SPEC-109](2026-10-14-benchmark-builder.md)).
- LLM-judge / rubric grading; sets and chains of skills (S3; D02).
- Codex and Cursor adapters, the Claude Agent SDK option, gateways, cloud providers and model
  providers ([SPEC-204](2026-10-14-integration-openai-codex.md), [SPEC-205](2026-10-14-integration-cursor.md), [SPEC-206](2026-10-14-integration-anthropic-api.md)…).
- `environment.kind: docker`; live MCP/Figma inputs in fixtures (fixtures are files only).
- Assertions on the agent's final chat answer (S1 grades files the agent writes).
- Categories (#22) and the rest of E02 (#20, #21) — they wait per D08.
- Solving D03/Q05 (how "verdicts hold in real projects" is measured); S1 only makes the data
  that such a measurement needs.

## 5. User stories

- US-118-01: As a skill author, I run `directivebench benchmark init --artifact estimate-project`
  and get a suite folder with a valid `benchmark.yaml` and a `fixtures/` folder I fill with a real
  brief and transcript.
- US-118-02: As a skill author, I run my suite against the latest version of my skill with no
  baseline artifact, and see whether the skill helps at all.
- US-118-03: As a skill author, I run the same suite with `--baseline v3` and see whether v4 is
  better than v3 on the same inputs and checks.
- US-118-04: As a skill author, I require that the output document has the headings "Assumptions",
  "Estimate" and "Risks", mentions QA and project management, and that the "Backend API" row's
  "Hours" column is between 16 and 40.
- US-118-05: As a skill author, I open my artifact in the web UI and see, per version, which runs
  exist, what each was compared with, and whether the results are comparable.
- US-118-06: As a user on a subscription, I am told before the run how many Claude Code sessions
  will start, that they count against my plan, that my user-level instructions may influence the
  result and that nothing is sandboxed.

## 6. Functional requirements

### 6.1 Claude Code execution adapter

| ID | Requirement |
| --- | --- |
| FR-118-01 | `packages/agent-adapters` SHALL provide an executable `claude-code` adapter implementing [SPEC-203](2026-10-14-integration-claude-code.md) §2–§9 for the scope of this slice: CLI print mode with `stream-json`, the argv of §6, prompt on stdin, the `edit-only` permission profile by default (`edit-and-shell` only for execution-approved suites), install convention §4.1, cancellation and timeout escalation, stream parsing, usage reporting and the error codes of §9. |
| FR-118-02 | The adapter SHALL support both auth modes of SPEC-203 §3: **Local Subscription Mode (default)** and **API Key Mode**. In S1, API Key Mode reads the key only from the `ANTHROPIC_API_KEY` variable of the CLI process environment (secret reference `{ source: 'env', name: 'ANTHROPIC_API_KEY' }`); OS-keychain references wait for [ADR-0008](../decisions/0008-secret-storage-and-authentication.md). Gateway and cloud-provider modes are not offered. |
| FR-118-03 | In Local Subscription Mode the adapter SHALL record warning `ambient-user-config` on every run and isolation profile `user-profile`; in API Key Mode it SHALL isolate `HOME` and `CLAUDE_CONFIG_DIR` to the run directory and record isolation profile `isolated` (SPEC-203 §8). |
| FR-118-04 | Every agent run SHALL report adapter metadata `{ adapterVersion, authMode, isolationProfile, permissionProfile, requestedModel, reportedModels[], flagsHash }` (SPEC-203 §4.2). `flagsHash` is the sha256 of the argv **normalised**: without the prompt and with run-local paths (workspace, isolated `HOME`, temp directories) replaced by fixed placeholders, so two workspaces of one run hash equally. The engine records the metadata once per benchmark run in `EnvironmentMetadata` and checks that `adapterVersion`, `authMode`, `isolationProfile`, `permissionProfile`, `requestedModel` and `flagsHash` are identical for every agent run (SPEC-112 FR-112-08). A difference in `reportedModels` (e.g. an alias resolving to another snapshot) is a warning `unpinned-model`, not a comparability failure. |
| FR-118-05 | `createExecutableAdapters()` SHALL include `claude-code` only in the runner that `benchmark run` starts (§6.4). The `serve` runner stays mock-only in S1, and the web app SHALL NOT enqueue a run whose suite uses an agent other than `mock` (§11). |
| FR-118-06 | A fixture or verification overlay that contains `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `CLAUDE.local.md` or a `.claude/hooks/` directory SHALL be treated as running commands: the suite needs execution approval (FR-118-33), and the plan lists those files. Independently of approval, the adapter SHALL refuse a run whose project settings set `env`, `apiKeyHelper`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or a `CLAUDE_CODE_USE_*` key, because they would change where requests go or who pays (`infrastructure-error`, code `fixture-overrides-auth`). The adapter SHALL also check the auth source reported in the `system/init` event (field name: Assumption — requires validation, SPEC-203 §3) against the chosen mode and record `auth-mismatch` (agent run `agent-error`) when they differ. |
| FR-118-07 | Both permission profiles SHALL confine edits to the workspace (`--permission-mode dontAsk` with allow rules scoped to the workspace; no `--add-dir`); a test SHALL show that an attempted edit of a path outside the workspace (e.g. `~/.claude/CLAUDE.md`) is denied and recorded as `permission-denied`. Shell commands (`edit-and-shell`) are not confined on `local-process`; that residual is labelled "Not sandboxed". |

### 6.2 Baseline selection (A/B)

| ID | Requirement |
| --- | --- |
| FR-118-10 | A benchmark run SHALL have a **baseline kind**: `none` (no artifact, the existing RED/GREEN semantics) or `artifact-version` (a named version of the **same** artifact as the candidate). |
| FR-118-11 | With `artifact-version`, the baseline variant SHALL install the baseline version with exactly the same adapter install convention, paths and procedure as the candidate; everything else in SPEC-112 FR-112-04/05 is unchanged (same fixture, prompt, adapter, model, flags, limits, fresh workspace per agent run, interleaved order). |
| FR-118-12 | The baseline version SHALL differ from the candidate version (different `artifact_versions.id` **and** content hash); same artifact, same format. Violations are rejected before any job is created. |
| FR-118-13 | The baseline SHALL be stored on the benchmark run (`benchmark_runs.baseline_artifact_version_id`, null = `none`, §8). It is **not** part of the comparability key (§8.3): the key describes the conditions, the baseline describes what the candidate was compared with. |
| FR-118-14 | Delta, verdict and display status keep their SPEC-111 meaning with "baseline" read as "the chosen baseline": `improved` in an A/B run means the candidate version scored better than the baseline version. Every surface SHALL name the baseline ("Baseline: no artifact" / "Baseline: v3"). |
| FR-118-15 | When an agent run ends with `auth-missing`, `auth-expired`, `auth-invalid`, `billing`, `rate-limited` or `auth-mismatch`, the run SHALL NOT start further agent runs: remaining runs are not executed, the benchmark run ends with status `error` and the reason, so a broken login or exhausted quota is not spent on runs that cannot succeed. Other agent-run failures (timeout, `agent-failed`, parse errors) are recorded and the run continues (SPEC-112 §13). |

### 6.3 Suites bound to registry artifacts

| ID | Requirement |
| --- | --- |
| FR-118-20 | `directivebench benchmark init --artifact <ref>` SHALL create the folder `./<name>-benchmark/` in the current directory containing `benchmark.yaml` and `fixtures/example/README.md`, where `<name>` is the artifact slug normalised to the suite-id pattern of FR-108-06 (lowercase, `[a-z0-9-]`, at most 70 characters; an empty result becomes `artifact`). The target path SHALL be confined to the current directory; it refuses a path that exists and is not an empty directory. It writes nothing to the database. |
| FR-118-21 | The scaffolded `benchmark.yaml` SHALL validate against the format as written: `id` = `<artifact-slug>-benchmark`, `artifactTypes: [<artifact type>]`, `execution.agent: claude-code`, `execution.model: null`, `repetitions: 3`, one case `example` with a placeholder prompt, `fixture.path: fixtures/example`, and one `markdown-sections` assertion on `output.md` as an editable example; comments explain each field and list the other assertion types. |
| FR-118-22 | `<ref>` SHALL resolve, in order, to an artifact id or an artifact slug ([SPEC-101](2026-10-14-artifact-registry.md)); for `benchmark run`, `--version <n>` selects a version number (default: latest; `init` binds to the artifact, not a version). An unknown or ambiguous reference fails with exit code 2 and the closest matches. |
| FR-118-23 | `benchmark run <suite>` SHALL accept a path to a definition file or to a folder containing `benchmark.yaml`, and import it with the existing `prepareSuiteImport` + `importSuiteVersion` path (content-addressed, idempotent: unchanged content reuses the existing suite version). |
| FR-118-24 | After any benchmark run that reaches status `completed` (whatever its verdict) the CLI SHALL record the assignment artifact ↔ suite (`artifact_benchmark_assignments`, existing table) so the artifact page lists the suite. |
| FR-118-25 | The artifact type SHALL be in the suite's `artifactTypes` and its format SHALL be installable by the adapter (SPEC-203 §4.1); otherwise the run is refused before any job is created, with the reason. |

### 6.4 `benchmark run`

| ID | Requirement |
| --- | --- |
| FR-118-30 | `directivebench benchmark run <suite> --artifact <ref> [--version <n>] [--baseline none\|v<n>] [--auth subscription\|api-key] [--max-budget-usd <n>] [--approve-commands] [--yes] [--json]`. Defaults: latest version, `--baseline none`, `--auth subscription`. `--max-budget-usd` is accepted only with `--auth api-key` (exit 2 otherwise), because the CLI enforces it only in print mode with an API key (SPEC-203 §4). Subscription mode has no cost cap; the plan (FR-118-31) is the guard. |
| FR-118-31 | Before starting, the CLI SHALL print the plan: suite (name, version, content hash prefix), candidate and baseline, agent and detected version, auth mode, isolation profile, model (or "CLI default — unpinned"), number of agent runs (`cases × repetitions × 2`), and these notices: runs count against the user's Claude plan (subscription) or API spend (api-key); prompt, fixture files and the artifact are sent to Anthropic; **Not sandboxed**; in subscription mode "may include user-level instructions". |
| FR-118-32 | On an interactive terminal the CLI SHALL ask for confirmation; `--yes` skips it; without a TTY and without `--yes` it SHALL refuse with exit code 2. |
| FR-118-33 | A suite version that runs commands (`definitionRunsCommands`, or FR-118-06) SHALL run only when execution-approved. `--approve-commands` SHALL print every `setup` and `command` argv and every FR-118-06 file of the suite version; approval with source `user` (SPEC-110 FR-110-46) is recorded only after the confirmation of FR-118-32, in the same transaction that creates the job. Without the flag such a suite is refused with exit code 2 and a message naming the flag. Approval is per suite version, so changing the suite requires approving again. |
| FR-118-34 | The CLI SHALL create the benchmark job **already acquired by its own runner** (one statement inserting `status = 'running'` with its `runner_id`), heartbeat it and execute it in-process, so a concurrently running `serve` runner can never pick it up (SPEC-114). A CLI killed mid-run leaves the job to the existing stale-heartbeat recovery (`interrupted`). |
| FR-118-35 | Readiness SHALL be checked before the job is created: `claude` found and version ≥ the minimum (SPEC-203 §7); in subscription mode `claude auth status` reports logged in (parsing only the fields needed, never persisting the output); in api-key mode `ANTHROPIC_API_KEY` is non-empty. Failures exit with code 2 and the SPEC-203 §9 error code. |
| FR-118-36 | SIGINT during the run SHALL cancel the job through its `AbortSignal` (SPEC-203 cancellation escalation), record `cancelled` and exit with code 130. |
| FR-118-37 | At the end the CLI SHALL print the same summary as `demo` (baseline, candidate, delta, verdict, confidence, display status, run id) plus warnings and tokens/cost (cost "n/a (subscription)" in subscription mode, "estimated" in api-key mode, SPEC-203 §4). `--json` prints one JSON object instead. |
| FR-118-38 | Exit code: 0 when the display status is `passed`; 6 for `failed`, `regression`, `unstable`, `error` and `not-comparable` (roadmap M3: non-zero on regressed/failed); 130 on cancel; 2 for usage and readiness errors. |
| FR-118-39 | Order of a `benchmark run`: validate the definition and snapshot fixtures in memory/temporary store → resolve artifact and baseline → readiness (FR-118-35) → plan and confirmation (FR-118-31/32) → one transaction that imports the suite version (if new), records approval (if requested) and creates the acquired job (FR-118-34). Every refusal before that transaction leaves the database unchanged. |

### 6.5 Document-oriented assertions

All three are deterministic, never execute commands, never throw (failures become failed
assertions with a message), read at most 2 MiB per file (as `file-contains`) and pass or fail
(score 0 or 1); weights and `required` work as for every assertion (SPEC-111).

| ID | Requirement |
| --- | --- |
| FR-118-40 | **Target file.** Each new assertion has `file`: a workspace-relative POSIX path, or a glob (`*`, `**`, `?`, `[…]`). A glob matches only files the agent added or modified (`changedFiles`), and exactly one file must match; zero or several matches fail with the list of matches. Paths are confined to the workspace (`resolveInside`). |
| FR-118-41 | **`markdown-sections`** `{ file, headings: (string \| { pattern, flags? })[], ordered?: false }` passes iff every listed heading occurs as an ATX or setext heading of any level. A string matches the heading text case-insensitively after trimming and collapsing whitespace; a `{ pattern }` is a regular expression as in `file-contains`. With `ordered: true` the headings must occur in the listed order. Headings inside fenced code blocks do not count. Details: found and missing headings. |
| FR-118-42 | **`required-phrases`** `{ file, phrases: (string \| { pattern, flags? })[], caseSensitive?: false }` passes iff every phrase occurs in the file text (alternatives are written as one pattern). A string is a literal (no regular expression); whitespace runs match any whitespace run. Details: found and missing phrases. |
| FR-118-43 | **`markdown-table-value`** `{ file, row: { pattern, flags? }, column, min?, max?, decimalSeparator?: '.' \| ',' }` scans the GFM tables of the file in order, takes the first body row whose first cell matches `row.pattern` in a table that has a header cell equal to `column` (case-insensitive, trimmed), parses the first number of that cell and passes iff `min ≤ value ≤ max` (at least one bound required; bounds inclusive). No matching row or column, or no number in the cell, fails with that reason. Details: table index, row text, cell text, parsed value. Selecting other row columns or checking every matching row is future work (§19). |
| FR-118-44 | **Number parsing** for FR-118-43: the first token matching an optional sign, digits with optional grouping and an optional decimal part. `decimalSeparator: '.'` (default) treats `,`, spaces, no-break and thin spaces as grouping; `','` treats `.` and those spaces as grouping. A range such as `8–12` yields its first number (8); users who need the upper bound match a separate column or row. |
| FR-118-45 | The three types SHALL be added to the format v1 union additively (no `schemaVersion` change): existing definitions validate and hash exactly as before ([SPEC-108](2026-10-14-benchmark-definition-format.md)). Regular expressions follow FR-108-10 (flags `i`, `m`, `s`, `u`; invalid patterns are validation errors at their path). |

### 6.6 Results per artifact version (web, read-only)

| ID | Requirement |
| --- | --- |
| FR-118-50 | The artifact detail page SHALL list the artifact's versions, newest first, and per version its completed benchmark runs: suite name and version, baseline ("no artifact" / "vN"), agent and version, auth mode and isolation profile, model, display status, delta, confidence, date, link to the run. |
| FR-118-51 | Runs SHALL be grouped by comparability key; groups are labelled "not comparable with each other" and no number is compared across groups (SPEC-111 FR-111-45). Within a group, version regressions are highlighted per SPEC-111 FR-111-50…52. |
| FR-118-52 | The run detail page SHALL show the baseline in its header and column labels ("Baseline (no artifact)" / "Baseline (v3)" vs "Candidate (v4)"), the auth mode, isolation profile, permission profile, warnings including `ambient-user-config` with the text "may include user-level instructions", tokens and cost as reported (never invented), the new assertions' details, and the Claude Code trace (tool calls, permission denials, retries) as escaped text. |
| FR-118-53 | For a suite whose agent is not `mock`, the UI SHALL NOT offer "Run"; it shows the CLI command to run instead (running from the UI is S2). |

## 7. Non-functional requirements

- NFR-118-01: No paid or authenticated call in CI or in `pnpm test`; the adapter is tested with
  recorded, redacted stream fixtures and a fake `claude` executable (SPEC-203 §11).
- NFR-118-02: The new assertions evaluate a 2 MiB Markdown file in < 200 ms and in linear time;
  heading and table parsing are line-based scans without backtracking regular expressions over the
  whole file (lessons 2026-10-21 on delimited spans and superlinear parses).
- NFR-118-03: Engine overhead per agent run stays < 2 s (NFR-107-01); the CLI adds < 1 s before
  the first agent starts, excluding `claude auth status`.
- NFR-118-04: Linux and macOS. Windows is best effort (process-tree kill: SPEC-203 §10).
- NFR-118-05: 100% unit coverage for all new logic (AGENTS.md §2.7); Playwright for the new UI
  paths, driven by stored fixture runs, not by a live agent.

## 8. Domain entities and contracts

### 8.1 Data model

One additive, nullable column; no other schema change. Existing rows read as baseline `none`.

| Table | Change |
| --- | --- |
| `benchmark_runs` | `baseline_artifact_version_id text NULL REFERENCES artifact_versions(id)`; index with `artifact_version_id`. |
| `jobs.payload` (`benchmark-run`) | Optional `baselineArtifactVersionId`, `auth: { mode: 'subscription' \| 'api-key' }`, `maxBudgetUsd?`. The payload never contains a secret value. |
| `benchmark_suite_versions` | Unchanged; `execution_approval_source = 'user'` is now written by `--approve-commands`. |
| `artifact_benchmark_assignments` | Unchanged; now written by `benchmark run` (FR-118-24). |

```mermaid
flowchart LR
    classDef newEntity fill:#2f6feb,color:#fff,stroke:#1b4fb0
    classDef existingEntity fill:#e5e7eb,color:#111,stroke:#9ca3af

    entity_1["benchmark_runs (changed: baseline_artifact_version_id)"]:::newEntity
    entity_2["artifact_versions"]:::existingEntity
    entity_3["benchmark_suite_versions"]:::existingEntity
    entity_4["artifacts"]:::existingEntity
    entity_5["artifact_benchmark_assignments"]:::existingEntity
    entity_6["benchmark_suites"]:::existingEntity

    entity_1 -->|"n-1 candidate"| entity_2
    entity_1 -->|"n-0..1 baseline"| entity_2
    entity_1 -->|n-1| entity_3
    entity_2 -->|n-1| entity_4
    entity_5 -->|n-1| entity_4
    entity_5 -->|n-1| entity_6
    entity_3 -->|n-1| entity_6
```

The baseline version must belong to the same artifact as the candidate (FR-118-12); that is
checked when the job is created and again by the runner, not by a database constraint.

### 8.2 Engine contract changes ([SPEC-107](2026-10-14-benchmark-engine.md) §8.1)

```ts
interface RunBenchmarkInput {
  // existing fields unchanged
  artifact: ArtifactBundle;               // candidate
  baselineArtifact?: ArtifactBundle;      // absent = baseline kind 'none' (FR-118-10/11)
}

// Adapter metadata (SPEC-203 §4.2), recorded in EnvironmentMetadata.agentProfile
interface AgentProfile {
  authMode: 'subscription' | 'api-key';
  isolationProfile: 'isolated' | 'user-profile';
  permissionProfile: 'edit-only' | 'edit-and-shell';
  flagsHash: string;                      // sha256 of the argv without the prompt
  hostId?: string;                        // only for 'user-profile', §8.3
}
```

`assertRunnable` additionally rejects a `baselineArtifact` of another artifact, of the same
content hash, or of another format than the candidate.

### 8.3 Comparability key ([SPEC-111](2026-10-14-benchmark-scoring.md) FR-111-43)

The hashed object gains `agentProfile` **only when the adapter reports one**; the mock adapter
reports none, so every existing key stays byte-identical. In `user-profile` isolation the profile
carries `hostId`, a random identifier created once in the data directory's `config.json`, so runs
that may include one machine's user-level configuration never share a key with another machine's
runs (export/import is future work). The baseline is not part of the key (FR-118-13).

### 8.4 Assertion definitions ([SPEC-108](2026-10-14-benchmark-definition-format.md) §8.1)

```ts
type TextMatcher = string | { pattern: string; flags?: string };       // flags ⊆ 'imsu'

| { type: 'markdown-sections'; file: string; headings: TextMatcher[];    // min 1
    ordered: boolean /*false*/ } & Common
| { type: 'required-phrases'; file: string; phrases: TextMatcher[];      // min 1
    caseSensitive: boolean /*false*/ } & Common
| { type: 'markdown-table-value'; file: string;
    row: { pattern: string; flags?: string }; column: string;
    min?: number; max?: number /* at least one */; decimalSeparator: '.' | ',' /*'.'*/ } & Common
```

Reference-scenario example (illustrative only; nothing in the product knows about estimates):

```yaml
assertions:
  - id: structure
    type: markdown-sections
    file: "**/*.md"
    headings: [Assumptions, Estimate, Risks]
    ordered: true
  - id: mentions-qa-and-pm
    type: required-phrases
    file: "**/*.md"
    phrases: [QA, { pattern: "project manag|PM\\b", flags: i }]
  - id: backend-hours-realistic
    type: markdown-table-value
    file: "**/*.md"
    row: { pattern: "Backend API", flags: i }
    column: Hours
    min: 16
    max: 40
    weight: 3
```

## 9. Data flow

```mermaid
flowchart LR
  subgraph CLI["directivebench benchmark run (new)"]
    P[parse args + validate suite<br/>resolve artifact/baseline] --> C[readiness + plan + confirmation]
    C --> J[one transaction: import suite version,<br/>approval if requested, job already running]
    J --> R[LocalRunner with claude-code + mock]
  end
  R --> E[runBenchmark<br/>baseline: none or vN]
  E <--> A[ClaudeCodeAdapter → claude -p<br/>new]
  E --> X[new assertions]
  R --> DB[(benchmark_runs + baseline,<br/>agent_runs, assertion_results)]
  DB --> W[web: artifact versions + run detail<br/>read-only]
```

Takeaway: the CLI is the only process that executes a real agent in S1; the web app only reads
what that run persisted.

## 10. API and interface design

- **CLI** (`apps/cli`, [SPEC-009](2026-10-14-cli-architecture.md)): `benchmark init` and
  `benchmark run` as in FR-118-20…38. They are registered only when implemented (SPEC-009 §2:
  no stubs). `benchmark list` stays future.
- **Database** (`packages/database`): `createAcquiredBenchmarkJob(db, payload, runnerId, now)`
  (one `INSERT … RETURNING`), `resolveArtifactRef(db, ref, version?)`,
  `approveSuiteVersion(db, suiteVersionId, 'user', now)` (one conditional `UPDATE`),
  `listArtifactRuns(db, artifactId)` grouped by version and comparability key, and the new column
  in `createBenchmarkRun` / `getBenchmarkRunDetail`. Zod schemas for the extended job payload.
- **Runner** (`packages/runner`): `LocalRunner.runAcquiredJob(jobId)` executes one job the
  caller already owns, with heartbeat and cancellation as for polled jobs; the benchmark handler
  loads the baseline bundle and validates FR-118-12 again.
- **Engine** (`packages/benchmark-engine`): §8.2, §8.4; the assertion plugin registry of
  SPEC-107 §8.3 is introduced with the first new type (SPEC-107 "refactor when adding the first
  planned type").
- **Adapters** (`packages/agent-adapters`): `ClaudeCodeAdapter` per SPEC-203 §5 file layout;
  contract extensions of SPEC-203 §4.2 that S1 needs (`auth`, `errorCode`, `warnings`,
  `metadata`, the new trace events, `costIsEstimate`).

## 11. UI/UX considerations

S1 UI is read-only; there is no new page, only changes to existing ones.

- **Artifact detail** (`/artifacts/[id]`): a "Benchmark results by version" section replaces the
  flat history: one block per artifact version (newest first) with a table per comparability
  group (FR-118-50/51). Empty state: "No benchmark runs yet. Create a suite with
  `directivebench benchmark init --artifact <slug>`." The command is shown as copyable text.
- **Run detail** (`/results/[id]`): baseline named in the header and columns; an "Agent profile"
  row (auth mode, isolation, permission profile, model requested / reported); warnings panel
  shows `ambient-user-config` as "May include user-level instructions (Local Subscription Mode)";
  tokens and cost as reported, cost labelled "estimated" or "n/a (subscription)"; badges "Not
  sandboxed" and, for real agents, "Real agent — results vary between runs" next to confidence.
- **Benchmark page** (`/benchmarks/[id]`): for a non-mock suite the Run button is replaced by
  "Run from the CLI" with the command (FR-118-53); an "AI evaluation" result is never shown with
  the mock label and a mock result never without it.
- Status, labels and accessibility follow [SPEC-113](2026-10-14-results-and-reporting.md) §11.

Prototype: none. Mockups were not produced for this spec (the configured browser provider and
the shared test environment were not available to the authoring run); the changes reuse the
existing tables and badges.

## 12. Security considerations

Baseline: [SPEC-203 §8](2026-10-14-integration-claude-code.md#8-security-concerns),
[SPEC-007](2026-10-14-security-and-privacy.md), [ADR-0007](../decisions/0007-local-runner-execution-and-isolation.md).
Additions and residual risks of this slice:

- **Ambient configuration leakage (subscription, default).** With the real `HOME`, Claude Code
  loads `~/.claude/CLAUDE.md`, user rules, user skills (including claude.ai-synced ones) and
  managed policy files into **both** variants. Mitigations: `--setting-sources project,local`,
  warning `ambient-user-config` on every run, `user-profile` in the comparability key with a
  per-installation `hostId`, and the UI label. Residual: a user skill that overlaps the candidate
  can mask or inflate its effect; results are only as clean as the user's `~/.claude`. API Key
  Mode is the clean mode. This does not contradict D05 (D05 governs scanning user-level folders
  into the registry; nothing here reads them).
- **Terms.** Whether driving the user's own logged-in CLI for automated benchmarking is within
  the subscription terms is the open review in SPEC-203 §3.2. DirectiveBench never reads,
  copies or stores CLI credentials, offers no claude.ai login and does not embed the Agent SDK.
  The review must be recorded in SPEC-203 before a release that enables subscription mode by
  default (§18).
- **Cost.** Every run costs `cases × repetitions × 2` agent sessions (and up to
  `maxBudgetUsd` per session in api-key mode). FR-118-31/32 make the number visible and require
  confirmation; there is no automatic retry (SPEC-112 FR-112-12).
- **Command approval from the CLI.** `--approve-commands` is a new approval channel next to the
  planned UI approval; it prints every argv before recording approval and binds it to the
  content-hashed suite version (FR-118-33).
- **Not sandboxed.** The agent runs with the user's OS permissions; Bash is off unless the suite
  is approved and asks for `edit-and-shell`. Fixture `.claude/settings*.json` with hooks and
  `.mcp.json` are flagged as "executes code" and need approval (SPEC-203 §8).
- **Secrets.** The API key exists only in the agent child's environment; never in argv, job
  payload, database, logs, traces or CLI output; the exact value is added to redaction.
- **Untrusted output.** Agent output, traces and assertion details are rendered as escaped text;
  the new parsers never evaluate Markdown or HTML.

## 13. Error handling

| Condition | User sees | Persisted |
| --- | --- | --- |
| Unknown suite path, invalid YAML, failing validation | All issues with dotted paths; exit 2 | Nothing |
| Unknown/ambiguous artifact or version, bad `--baseline`, baseline = candidate | Reason and closest matches; exit 2 | Nothing |
| Artifact type/format not supported by suite or adapter | Reason; exit 2 | Nothing |
| `claude` missing / too old / not logged in / no API key | SPEC-203 §9 code and a fix hint; exit 2 | Nothing |
| Suite runs commands, no approval | Message naming `--approve-commands`; exit 2 | Nothing |
| No TTY and no `--yes` | Message naming `--yes`; exit 2 | Nothing |
| Agent run fails (auth expired, rate limit, budget, parse error, timeout) | Per-run status and code in summary; run continues with other agent runs | `agent_runs` with status and code |
| Ctrl-C | "Cancelled"; exit 130 | Job and benchmark run `cancelled` |
| CLI killed | — | Job `interrupted` by the next runner start (SPEC-114 FR-114-06) |
| Assertion target missing / several glob matches / unparsable number | Failed assertion with reason | `assertion_results.details` |

## 14. Edge cases

- The artifact has only one version: `--baseline vN` fails with "this artifact has one version";
  `--baseline none` works.
- The baseline version's files are identical to the candidate's under another id: rejected
  (FR-118-12, same content hash).
- The artifact was rescanned between `init` and `run`: `run` uses the latest version unless
  `--version` is given; the plan names the version.
- The scan did not store some files of a skill (e.g. binary supporting files): the install
  writes what the version holds; the author sees the stored files on the artifact page.
- The fixture already contains `.claude/skills/<slug>/` or a `CLAUDE.md`: candidate/baseline
  install conflict rules of SPEC-203 §4.1 apply; an existing skill path → `infrastructure-error`
  `artifact-install-conflict`.
- The agent writes no output file: the new assertions fail with "no file matched"; the run is
  still `completed`.
- The agent writes two Markdown files and the assertion uses a glob: fail with both names; the
  author narrows the glob or names the file in the prompt.
- `claude` auto-updates during a run: SPEC-112 FR-112-08 → `not-comparable`.
- `execution.model: null`: CLI default model; warning `unpinned-model` (FR-118-04); reported model shown.
- Two `benchmark run` processes at once: allowed (each owns its job), but they share the plan's rate limits; the plan notice says so and a `rate-limited` result stops the affected run (FR-118-15).
- Suite edited after a run: re-import creates a new suite version; earlier runs keep theirs and
  land in another comparability group.

## 15. Testing strategy

Per [SPEC-012](2026-10-14-testing-strategy.md); no live agent in CI.

- **Unit:** each new assertion (headings: ATX/setext, ordered, code fences;
  phrases: literal vs pattern, whitespace, case; table: row/column selection, first match,
  both separators, grouping spaces, ranges, missing pieces, glob 0/1/2 matches,
  2 MiB cap, a linear-time check with a size ratio); schema additions (defaults, invalid regex
  paths, existing examples hash unchanged); comparability key unchanged for mock, changed by
  `agentProfile` and `hostId`; A/B validation in `assertRunnable`; argv/env builders, version
  parser and stream parser per SPEC-203 §11; job creation as `running` in one statement;
  `resolveArtifactRef`; CLI argument parsing, plan text, confirmation, exit-code mapping.
- **Integration:** `runBenchmark` with `baselineArtifact` and the mock agent (baseline workspace
  holds exactly the baseline version, candidate exactly the candidate); `benchmark run` against a
  temp data dir with a fake `claude` on `PATH` emitting recorded NDJSON, for subscription and
  api-key modes (env assertions: no `ANTHROPIC_*` in subscription; isolated `HOME` in api-key;
  key absent from argv, DB, logs and stdout); a concurrent `LocalRunner` polling the same DB never
  acquires the CLI's job; SIGINT → `cancelled` and process group gone within 10 s.
- **E2E (Playwright):** seeded runs (two versions, A/B and `none`, two comparability groups) →
  artifact page groups and labels; run detail shows baseline label, agent profile, warnings and
  "not reported" tokens where absent; benchmark page shows "Run from the CLI" for a non-mock suite.
- **Manual, opt-in (`DIRECTIVEBENCH_LIVE_TESTS=claude-code`):** one tiny suite, both auth modes;
  refreshes the recorded fixtures after redaction review.

## 16. Acceptance criteria

- [ ] AC-1: `benchmark init --artifact <slug>` creates a folder whose `benchmark.yaml` validates unchanged, and refuses a non-empty target.
- [ ] AC-2: `benchmark run <folder> --artifact <slug> --yes` with a fake `claude` completes a RED/GREEN run of `cases × repetitions × 2` agent runs, persists it bound to the artifact's latest version and records the assignment.
- [ ] AC-3: With `--baseline v<n>` the baseline workspace contains exactly version n and the candidate exactly the chosen version; `benchmark_runs.baseline_artifact_version_id` is set; same-content, other-artifact and other-format baselines are rejected before a job exists.
- [ ] AC-4: In subscription mode no `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_CODE_USE_*` variable reaches the agent and every run carries `ambient-user-config`; in api-key mode `HOME`/`CLAUDE_CONFIG_DIR` are run-local and the key appears in no argv, row, log, trace or CLI output (planted-key test).
- [ ] AC-5: The comparability key of the bundled mock example is byte-identical before and after this change; two runs differing only in auth mode, isolation profile, permission profile or `hostId` get different keys; baseline choice does not change the key.
- [ ] AC-6: The three new assertions behave as FR-118-40…44 on fixture documents, including the reference-scenario example of §8.4, and evaluate a 2 MiB document in < 200 ms.
- [ ] AC-7: A suite with `command` assertions is refused without `--approve-commands`; with it, every argv is printed and approval source `user` is recorded on that suite version only.
- [ ] AC-8: Without a TTY and without `--yes` the run is refused (exit 2); the plan lists the agent-run count and the cost, data-leaving and Not-sandboxed notices.
- [ ] AC-9: A `serve` runner polling the same data directory never acquires a job created by `benchmark run`.
- [ ] AC-10: Ctrl-C yields `cancelled` (exit 130) and no `claude` process remains after 10 s (fake CLI ignoring SIGINT).
- [ ] AC-11: Exit codes follow FR-118-38 for passed, failed, regression, unstable, error and not-comparable fixtures, 130 on cancel and 2 on usage errors.
- [ ] AC-12: The artifact page lists runs per version and comparability group with baseline, auth mode and isolation; the run detail names the baseline and shows the agent profile and the ambient-configuration warning; a non-mock suite has no Run button (Playwright).
- [ ] AC-13: `pnpm test` keeps 100% coverage; no test needs a credential or network.
- [ ] AC-14: An unknown or ambiguous artifact reference and an artifact format the adapter cannot install exit with code 2 before any database change; a slug with characters outside the suite-id pattern yields a confined folder name (FR-118-20/22/25).
- [ ] AC-15: Running the same unchanged suite folder twice reuses one suite version; every refusal before the final transaction (readiness, declined confirmation, missing approval) leaves the database unchanged, including no approval record (FR-118-23/39).
- [ ] AC-16: A fixture with `.claude/settings.json` or `.mcp.json` requires approval; one whose settings set `env`, `apiKeyHelper` or an `ANTHROPIC_*` key is refused with `fixture-overrides-auth`; an attempted edit outside the workspace is denied and recorded (FR-118-06/07).
- [ ] AC-17: With a fake `claude` returning `rate_limit` (or an expired login) on the first agent run, no further agent run starts and the benchmark run ends `error` (FR-118-15); `--max-budget-usd` without `--auth api-key` exits 2.
- [ ] AC-18: The flags hash of two agent runs in different workspaces is equal; a different reported model snapshot yields `unpinned-model`, not `not-comparable` (FR-118-04).
- [ ] AC-19: The web server action refuses to enqueue a suite whose agent is not `mock` even when called directly (FR-118-05), and version regressions within a comparability group are highlighted on the artifact page (FR-118-51).
- [ ] AC-20: The summary and the `--json` object contain baseline, candidate, delta, verdict, confidence, display status, run id, warnings and tokens/cost as reported (FR-118-37).

## 17. Dependencies

- Specs changed in the same change set (sections): [SPEC-203](2026-10-14-integration-claude-code.md)
  §4.1, §7, §12, §13 (baseline install, default auth mode and env-only key, S1 scope);
  [SPEC-107](2026-10-14-benchmark-engine.md) FR-107-06, §8.1, §8.3, §8.4;
  [SPEC-108](2026-10-14-benchmark-definition-format.md) §8.1, §19;
  [SPEC-110](2026-10-14-benchmark-execution.md) FR-110-05;
  [SPEC-111](2026-10-14-benchmark-scoring.md) FR-111-43;
  [SPEC-112](2026-10-14-red-green-evaluation.md) §4, FR-112-01/03, §19;
  [SPEC-113](2026-10-14-results-and-reporting.md) FR-113-10, FR-113-21;
  [SPEC-114](2026-10-14-runner-management.md) FR-114-02;
  [SPEC-009](2026-10-14-cli-architecture.md) §2; [SPEC-013](2026-10-14-implementation-roadmap.md) M3, M4, §4.
- [SPEC-115](2026-10-14-settings-and-configuration.md) gains a generated `installationId` in
  `config.json` (the `hostId` of §8.3); SPEC-115 is updated in the Phase 2 PR that adds it.
- Decisions: product brief D08 (supersedes D01), D02 (chains → S3), D03/Q05 (not solved here),
  D05 (not affected, §12). ADRs: [ADR-0005](../decisions/0005-custom-benchmark-engine.md),
  [ADR-0006](../decisions/0006-agent-adapters-vs-model-providers.md),
  [ADR-0007](../decisions/0007-local-runner-execution-and-isolation.md),
  [ADR-0008](../decisions/0008-secret-storage-and-authentication.md) (keychain deferred, env only).
- Packages: no new runtime dependency (Markdown heading/table scanning is a small line-based
  parser in `benchmark-engine`).

## 18. Open questions

Owner-level questions this slice does not answer (not blocking implementation):

- OQ-118-01 (maintainer): terms review of SPEC-203 §3.2 — must be recorded before a release that
  ships subscription mode as the default.
- OQ-118-02 (maintainer): what executes the reference skill inside the maintainer's internal tool;
  a Claude Code result may not transfer to that harness (risk to D03).
- OQ-118-03 (maintainer): cost sizing — repetitions × versions × fixtures against the plan's
  limits; no budget cap exists for subscription mode.
- OQ-118-04 (maintainer): D03 metric and stop condition (product brief Q05).
- Suggested cheap check in parallel (brief): two real briefs, `claude -p` three times each on
  v(n-1) and v(n), scored by a throwaway script, compared with the maintainer's own judgement.

## Resolved assumptions (autonomous defaults)

The brief's Resolved-unknowns table settles the agent, both auth modes with subscription as the
default, both baseline kinds, the S1 surfaces, suites on disk, deterministic grading, repetitions
for variance and file-only fixtures. These defaults cover what it leaves open; each can be
changed before merge.

| # | Question | Default | Why | Confirm? |
| --- | --- | --- | --- | --- |
| Q1 | Split adapter, CLI, assertions and UI into separate specs? | One spec, five independently shippable phases (§21) | The brief defines S1 as one slice; the phases ship separately | reversible |
| Q2 | What is `<suite>` in `benchmark run`? | A path to a definition file or suite folder, imported idempotently on each run | Reuses the existing import; suites stay versioned on disk | reversible |
| Q3 | How is the baseline chosen? | `--baseline none\|v<n>`, default `none`; same artifact, different content | Smallest flag surface; keeps today's semantics as default | reversible |
| Q4 | Where is the baseline stored, and is it in the comparability key? | Nullable column `benchmark_runs.baseline_artifact_version_id`; not in the key | History must show it; candidate scores stay comparable across baselines (FR-111-50) | reversible (additive) |
| Q5 | How does a CLI user approve a suite that runs commands? | `--approve-commands` prints every argv and records source `user` per suite version | The brief keeps `command` in S1 grading, and approval UX in the UI is not built; roadmap M3 says approval happens "in the UI" | ⚠ NEEDS HUMAN CONFIRMATION |
| Q6 | How does API Key Mode get the key without the keychain? | `ANTHROPIC_API_KEY` from the CLI environment only | ADR-0008 keychain storage is not accepted or built | reversible |
| Q7 | Can `serve` pick up a CLI-created job? | No: the CLI creates the job already acquired by its own runner | Avoids running a real agent in a process with another environment | reversible |
| Q8 | How are cost and consent handled? | Plan + notices before every run; TTY confirmation or `--yes`; refuse otherwise | Brief: UI and CLI must say runs count against the plan | reversible |
| Q9 | Which comparability dimensions are added? | `agentProfile` (auth, isolation, permissions, flags hash; `hostId` for user-profile), only when reported, so mock keys stay identical | Brief: mode and isolation are part of the key; "never compared across machines" | reversible |
| Q10 | How does an assertion find an output file whose name varies? | `file` accepts a glob over agent-changed files; exactly one match | Real agents choose names; avoids special-casing one skill | reversible |
| Q11 | How are numbers in table cells parsed? | First number; `decimalSeparator` `.` (default) or `,`; ranges use the first number | Covers common Polish/English notations without a locale engine | reversible |
| Q12 | Exit codes of `benchmark run`? | 0 only for `passed`; 6 otherwise; 2 usage; 130 cancel | Roadmap M3: non-zero on regressed/failed; reuses `ExitCode` | reversible |
| Q13 | Can the web UI start real-agent runs? | No; it shows the CLI command (S2 brings Run) | Brief: UI is read-only in S1 | reversible |

## 19. Future extensions

- S2: builder UI and "Run" from the UI ([SPEC-109](2026-10-14-benchmark-builder.md)), which also
  needs the UI approval flow.
- S3: `llm-judge` rubric grading (SPEC-107 §8.3), sets and chains of skills (D02).
- Codex and Cursor adapters; Agent SDK; keychain secret references; Docker.
- Assertions on the agent's final answer; per-cell partial credit; heading levels, "any of"
  phrases, other row-key columns and all-rows checks for the document assertions; `benchmark list`;
  JSON/Markdown export ([SPEC-113](2026-10-14-results-and-reporting.md) §6).
- Three-way runs (none, v(n-1), v(n)) in one benchmark run.

## 20. Implementation status

- **Implemented:** nothing; this is a design-only spec.
- **Partially implemented:** none. Existing pieces it builds on: Claude Code detection
  (SPEC-203 §13), RED/GREEN orchestration with the mock agent, suite import, the
  `artifact_benchmark_assignments` table and the artifact detail history (flat list, SPEC-113 §20).
- **Not implemented:** everything in §6.

## 21. Phasing and implementation plan

Each phase leaves the application working and is shippable on its own PR.

**Phase 1 — Document assertions** (engine only; useful with the mock agent).
1. Introduce the assertion plugin registry (SPEC-107 §8.3) with the four existing types; no
   behaviour change (existing tests unchanged, example hashes unchanged).
2. `file` target resolution (path or glob over changed files) with tests.
3. `markdown-sections`, then `required-phrases`, then `markdown-table-value` (+ number parsing),
   each with schema, evaluator, unit tests and a linear-time test.
4. Extend the mock example set with a specification-only document suite that validates.

**Phase 2 — A/B baseline, run storage and guards** (engine, database, runner, web action; mock agent).
1. `RunBenchmarkInput.baselineArtifact` + `assertRunnable` checks; integration test with the mock.
2. Migration adding `baseline_artifact_version_id`; job payload schema; runner loads and
   re-validates the baseline; `agentProfile` in `EnvironmentMetadata` and the comparability key
   (mock key unchanged test); `installationId` in `config.json` with the SPEC-115 update.
3. `createAcquiredBenchmarkJob` + `LocalRunner.runAcquiredJob`; concurrent-runner test.
4. Web server action and benchmark page refuse non-mock suites (FR-118-05/53) — before any
   adapter exists, so a `claude-code` suite can never be enqueued from the UI.

Phases 2 and 3 have no new user-visible behaviour on their own beyond the guard; they are
shippable because each leaves the mock path unchanged and fully tested.

**Phase 3 — Claude Code adapter** (agent-adapters).
1. Pure builders: argv (normalised flags hash), env per auth mode, version parser, install
   convention, fixture-settings checks (FR-118-06); unit tests.
2. Stream parser and error normalisation against recorded fixtures; stop-on-auth/quota codes
   (FR-118-15) in the engine.
3. Process control with the fake `claude` (stdin prompt, timeout, cancellation, process group,
   out-of-workspace edit denied).
4. Readiness (`auth status`, API key presence); detection reports `ready`/`missing`.

**Phase 4 — CLI** (cli, database queries).
1. `resolveArtifactRef`; `benchmark init` with scaffold and slug-confinement tests.
2. `benchmark run`: validation, readiness, plan, confirmation, approval, final transaction,
   in-process run, summary, `--json`, exit codes, SIGINT; integration tests with the fake `claude`.
3. Opt-in live check in both auth modes.

**Phase 5 — Read-only UI** (database queries, web).
1. `listArtifactRuns`; artifact page by version and comparability group with regression
   highlighting; run detail baseline and agent profile; Playwright tests on seeded runs.
2. Update SPEC-203/SPEC-118 implementation status only for what was verified.
