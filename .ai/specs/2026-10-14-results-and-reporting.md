---
id: SPEC-113
title: Results and Reporting
status: draft
created: 2026-10-14
updated: 2026-10-14
category: feature
related: [SPEC-111, SPEC-112, SPEC-110, SPEC-114, SPEC-101, SPEC-103, SPEC-116, SPEC-007, SPEC-006]
---

# SPEC-113 — Results and Reporting

## 1. Summary

This spec defines how benchmark results are presented and exported: the result statuses shown across the UI and how they are derived, the run detail view (RED vs GREEN comparison, per-assertion table, traces, environment, warnings, mock labelling), artifact-level latest result and history, and future JSON/Markdown report export with secret redaction. A hard rule applies throughout: **results produced by the Mock Agent are never presented as AI evaluation results.**

## 2. Motivation and problem statement

Users decide whether to keep, change or roll out an instruction based on what the results page says. A misleading status (e.g. "passed" when most runs errored, or a mock pipeline demo shown like a real model evaluation) is worse than no result. Results must be explainable down to individual assertions and commands, traceable to immutable inputs, and exportable without leaking secrets.

## 3. Goals

- One status vocabulary used consistently everywhere.
- Explainable results: every number drills down to runs, assertions, commands and output.
- Artifact-centric view: latest result per assigned benchmark plus history across versions.
- Honest labelling of mock results, non-sandboxed environments, low confidence and non-comparability.
- Redacted, portable exports (future).

## 4. Non-goals

- Cross-suite leaderboards or global rankings ([SPEC-111](2026-10-14-benchmark-scoring.md) FR-111-46).
- Hosted/public result sharing.
- Charts mixing results from different comparability keys.

## 5. User stories

- As a skill author, I open my artifact and see "passed — medium confidence" for its latest benchmark and a history of earlier versions.
- As a user, I open a run, compare RED and GREEN columns, and see which assertion made the baseline fail.
- As a user, I read the `node --test` output of a failing assertion in the trace.
- As a first-time user running the demo, I clearly see "Mock agent — not an AI evaluation".
- As a team lead (future), I export a Markdown report for a pull request, with tokens redacted.

## 6. Functional requirements

### Statuses

| ID | Requirement |
|---|---|
| FR-113-01 | Result display statuses SHALL be exactly: `passed`, `failed`, `regression`, `unstable`, `error`, `not-tested`, `not-comparable`. |
| FR-113-02 | Display status SHALL be derived by the scoring module ([SPEC-111](2026-10-14-benchmark-scoring.md) FR-111-34, `displayStatus()`); the verdict is stored on `benchmark_runs.verdict` and the display status in `benchmark_runs.summary.displayStatus`. The UI SHALL NOT re-derive it differently. |
| FR-113-03 | `not-tested` SHALL be shown for an artifact version × assigned suite with no `completed` benchmark run. |
| FR-113-04 | Benchmark run lifecycle states (`running`, `completed`, `error`, `cancelled`, `interrupted` — `benchmark_runs.status`) SHALL be shown separately from the display status; only `completed` benchmark runs have a display status. |
| FR-113-05 | Each status SHALL have a text label and an icon; colour SHALL never be the only carrier of meaning. |

| Status | Derivation (summary) | Meaning shown to the user |
|---|---|---|
| `error` | errorRate > 0.5 in either variant, or a case with no valid runs | Too many runs failed to execute; quality unknown |
| `not-comparable` | comparability/equivalence check failed | Baseline and candidate conditions differed |
| `unstable` | any case stdDev > stabilityThreshold or 0 < passRate < 1 | Results vary between repetitions |
| `regression` | delta ≤ −minDelta | Candidate scored worse than baseline |
| `passed` | none of the above and candidate passRate = 1 for all cases | Candidate passed every case in every repetition |
| `failed` | none of the above and candidate outcome failed | Candidate did not pass all cases |
| `not-tested` | no completed benchmark run | — |

### Run detail view

| ID | Requirement |
|---|---|
| FR-113-10 | The run detail SHALL show header: suite name + version, artifact name + version, agent adapter + version, model (or "none"), environment kind with sandbox badge ("Not sandboxed" for `local-process`), repetitions, started/finished, duration, display status, verdict reasons, confidence, comparability key (short). |
| FR-113-11 | A RED vs GREEN comparison SHALL show, per variant at suite level and per case: meanScore, passRate, errorRate, stdDev, min/max, validRuns, mean duration; delta and passRateDelta. |
| FR-113-12 | A per-assertion table SHALL show for each case and assertion: id, type, weight, required, deterministic, and per variant the pass count over valid runs (e.g. `0/3`, `3/3`) with links to individual results. |
| FR-113-13 | Per agent run, the view SHALL show execution status, score, passed, changed files, assertion results with messages, and the trace (stage timeline, commands with argv, exit code, duration, truncated/redacted stdout/stderr). |
| FR-113-14 | Environment metadata (platform, arch, node version, adapter version, environment kind, sandboxed) SHALL be shown. |
| FR-113-15 | Warnings (uncontrolled differences, `Σw = 0`, cleanup failures, overlay collisions, single nondeterministic run "not conclusive") SHALL be listed prominently. |
| FR-113-16 | When the adapter is the Mock Agent, the view SHALL show a persistent banner "Mock agent — not an AI evaluation" with a one-sentence explanation and link to [SPEC-112](2026-10-14-red-green-evaluation.md). |
| FR-113-17 | Tokens, cost and model usage SHALL only be shown when reported by the adapter; otherwise "not reported" (never zero, never estimated). |

### Artifact-level results

| ID | Requirement |
|---|---|
| FR-113-20 | Artifact detail SHALL show, per assigned suite, the latest completed result for the latest artifact version (display status, delta, confidence, date) or `not-tested`. |
| FR-113-21 | Artifact detail SHALL show evaluation history: all benchmark runs across artifact versions, newest first, grouped by comparability key; rows from different keys are not compared. |
| FR-113-22 | Version regressions ([SPEC-111](2026-10-14-benchmark-scoring.md) FR-111-50…52) SHALL be highlighted in the history. |
| FR-113-23 | Artifact lists SHALL show a compact status summarizing the worst display status among assigned suites for the latest version (precedence: error > not-comparable > unstable > regression > failed > passed > not-tested), with the mock label if all results are mock-only. |

### Report export (future)

| ID | Requirement |
|---|---|
| FR-113-30 | Export a benchmark run as JSON (machine-readable, schema-versioned) and Markdown (human-readable). |
| FR-113-31 | Exports SHALL include: inputs (suite version hash, artifact version hash, fixture hashes, adapter/model/environment), aggregates, verdict + reasons, per-assertion results, warnings, mock label when applicable, DirectiveBench version. |
| FR-113-32 | Exports SHALL pass all text (outputs, traces, prompts) through secret redaction (`redactSecrets` in `@directivebench/core`, including known configured secret values) and SHALL exclude absolute host paths outside the workspace by default (replaced with placeholders). |
| FR-113-33 | Markdown reports from Mock Agent runs SHALL start with the "Mock agent — not an AI evaluation" notice. |
| FR-113-34 | Exports SHALL NOT include raw workspace contents unless explicitly requested. |

## 7. Non-functional requirements

- Run detail loads in < 1 s for runs with ≤ 100 agent runs; traces lazy-loaded.
- All data shown is read from SQLite; the web app never executes anything ([SPEC-003](2026-10-14-system-architecture.md)).
- Accessible tables (header cells, captions), keyboard navigation ([SPEC-116](2026-10-14-dashboard-and-navigation.md)).

## 8. Domain entities and contracts

```ts
type DisplayStatus = "passed" | "failed" | "regression" | "unstable" | "error" | "not-tested" | "not-comparable";
type BenchmarkRunState = "running" | "completed" | "error" | "cancelled" | "interrupted";

interface RunDetailView {
  run: {
    id: string; state: BenchmarkRunState; displayStatus: DisplayStatus | null;
    reasons: string[]; confidence: "low" | "medium" | "high" | null;
    isMock: boolean; nondeterministic: boolean; comparabilityKey: string | null;
    startedAt: string; finishedAt: string | null;
  };
  suite: { id: string; name: string; version: number };
  artifact: { id: string; name: string; version: number };
  agent: { adapterId: string; displayName: string; version: string | null };
  model: { provider: string; model: string } | null;
  environment: { kind: string; sandboxed: boolean; platform: string; nodeVersion: string };
  comparison: ComparisonResult;                  // SPEC-111
  assertionMatrix: { caseId: string; assertionId: string; type: string; weight: number; required: boolean;
                     baseline: { passed: number; valid: number }; candidate: { passed: number; valid: number } }[];
  warnings: string[];
}

interface ReportExportV1 {
  reportVersion: 1;
  generatedAt: string;
  directivebenchVersion: string;
  notice?: "Mock agent — not an AI evaluation";
  run: RunDetailView["run"];
  inputs: { suiteVersionHash: string; artifactVersionHash: string; fixtureHashes: string[];
            agent: RunDetailView["agent"]; model: RunDetailView["model"]; environment: RunDetailView["environment"] };
  comparison: ComparisonResult;
  agentRuns: { caseId: string; variant: "baseline" | "candidate"; repetition: number; status: string;
               score: number | null; passed: boolean | null; assertions: unknown[]; traceRedacted?: unknown[] }[];
  warnings: string[];
}
```

## 9. Data flow

```mermaid
flowchart LR
  R[Runner] -->|persist| DB[(benchmark_runs / agent_runs / assertion_results)]
  DB --> Q[repository queries<br/>@directivebench/database]
  Q --> RD[Run detail page]
  Q --> AD[Artifact detail: latest + history]
  Q --> DSH[Dashboard widgets]
  Q --> EX[Export (future)] --> RED[redactSecrets] --> F[JSON / Markdown]
```

## 10. API and interface design

Pages (App Router, [SPEC-008](2026-10-14-api-architecture.md)): `/executions` (jobs), `/runs/[id]` (run detail), `/artifacts/[id]` (latest + history), `/results` (list of completed benchmark runs with filters by suite, artifact, status). Future route handlers: `GET /api/runs/[id]/export?format=json|md`.

Repository functions (database package): `getRunDetail(id)`, `listRunsForArtifact(artifactId)`, `latestResultsForArtifact(artifactId)`, `listResults(filters)`.

## 11. UI/UX considerations

- Status badges: same component everywhere (icon + label + tooltip with reasons).
- Mock banner uses a neutral informational style, not an error style, and cannot be dismissed on run detail.
- Low confidence and "not conclusive" shown next to the status, not hidden in tooltips.
- Long outputs collapsed with "show full (truncated at N bytes)".
- Empty state for artifacts without assigned suites: explain how to assign one (or link to spec if the action is not implemented).

## 12. Security considerations

- Traces and outputs are redacted before persistence ([SPEC-110](2026-10-14-benchmark-execution.md) FR-110-45) and again at export time (defence in depth).
- Rendering of outputs/prompts/artifact content SHALL be escaped text (no HTML injection from agent or fixture output); Markdown in artifacts is rendered sanitized.
- Exports never include secret references' values, environment variables, or host HOME paths ([SPEC-007](2026-10-14-security-and-privacy.md), [ADR 0008](../decisions/0008-secret-storage-and-authentication.md)).

## 13. Error handling

- Missing or corrupt run summary → show raw agent runs and a "summary unavailable — recompute" notice (recomputation from stored rows per [SPEC-111](2026-10-14-benchmark-scoring.md)).
- Run referencing a deleted artifact or suite → show ids with "deleted" marker (immutable versions are not deleted while referenced).
- `interrupted` / `error` benchmark runs show the error and a "Run again" action that enqueues a new job.

## 14. Edge cases

- Benchmark run still `running` → live progress (polling) with partial agent runs; no display status yet.
- Results with different comparability keys for the same artifact/suite → separate groups labelled "not comparable".
- Artifact assigned to a suite after previous runs → history still shows all runs.
- All results for an artifact are mock → artifact status shows the mock label.
- Extremely long changed-file lists → paginate.

## 15. Testing strategy

- Unit: status mapping and artifact-level worst-status aggregation.
- Component tests: mock banner presence; tokens shown as "not reported" when absent.
- E2E: `directivebench demo` data → run detail renders RED/GREEN, per-assertion matrix shows baseline `tests-validation` `0/N` and candidate `N/N`.
- Export (future): golden JSON/Markdown with planted secrets → redacted.

## 16. Acceptance criteria

- [ ] Only the seven statuses appear in the UI; derivation matches SPEC-111 for fixture data.
- [ ] Run detail shows RED vs GREEN aggregates, per-assertion matrix, traces, environment and warnings.
- [ ] Every Mock Agent run detail shows "Mock agent — not an AI evaluation"; no mock result appears without it.
- [ ] `local-process` runs show "Not sandboxed".
- [ ] Artifact detail shows latest result per assigned suite or `not-tested`, and history across versions grouped by comparability key.
- [ ] Tokens/cost show "not reported" for the Mock Agent.
- [ ] (Future) Exported reports contain no planted secret strings.

## 17. Dependencies

[SPEC-111](2026-10-14-benchmark-scoring.md), [SPEC-112](2026-10-14-red-green-evaluation.md), [SPEC-110](2026-10-14-benchmark-execution.md), [SPEC-114](2026-10-14-runner-management.md), [SPEC-101](2026-10-14-artifact-registry.md), [SPEC-103](2026-10-14-artifact-versioning.md), [SPEC-006](2026-10-14-database-schema.md), [SPEC-007](2026-10-14-security-and-privacy.md).

## 18. Open questions

- Should results list allow filtering by comparability key components (adapter, model)?
- Should exported JSON have a published JSON Schema and stability guarantees?
- Should `interrupted` benchmark runs be hidden from history by default?

## 19. Future extensions

- JSON/Markdown export, PR comment format, CI-friendly exit codes (`directivebench benchmark run`).
- Trend charts per comparability key.
- Shared results on a self-hosted server ([SPEC-011](2026-10-14-self-hosting-architecture.md)).
- Diff view of changed files between baseline and candidate.

## 20. Implementation status

- **Implemented (verified by `packages/runner/test/runner.test.ts` and `pnpm verify:pack` on 2026-10-14):** verdict stored on `benchmark_runs.verdict` and display status in `summary.displayStatus` (derived by `displayStatus()` in `@directivebench/benchmark-engine`); the comparability key stored on `benchmark_runs.comparability_key`; `/results` lists the demo run and the run detail page (`/results/[id]`) shows its verdict (`verify:pack`).
- **Verified by `pnpm test:e2e` (`apps/web/e2e/smoke.spec.ts`, 6/6 passing against the built CLI):** run detail shows baseline 50% / candidate 100% / +50 pts / verdict `improved` and 6 agent runs; dashboard and artifact list show the mock label and display status `passed`.
- **Partially implemented (present in `apps/web`, only partly covered by the tests above):** run detail with RED vs GREEN aggregates, per-agent-run assertion results, raw JSON trace, environment metadata, short comparability key, confidence with reason, warnings panel, "Mock agent — not an AI evaluation" and "Not sandboxed" badges; Executions page (jobs list with cancel); artifact detail with the latest RED/GREEN comparison and an evaluation history across versions — the history is a flat list (not grouped by comparability key) and the latest result is not broken down per assigned suite; dashboard recent runs. Tokens/cost "not reported" display is not implemented.
- **Not implemented:** report export (JSON/Markdown), version-regression highlighting, worst-status aggregation across assigned suites (FR-113-23), trend charts, results filtering beyond basic lists.
