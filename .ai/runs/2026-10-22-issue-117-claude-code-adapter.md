---
title: Compose ClaudeCodeAdapter and prove #96 end to end with the fake claude
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: maintainer request, issue #117 (parent #96)
status: in-progress
branch: feat/issue-117-claude-code-adapter
specs: [SPEC-118, SPEC-203]
---

# Run: Compose ClaudeCodeAdapter (issue #117)

## Objective

Compose `ClaudeCodeAdapter implements AgentAdapter` from the S03 pieces (#99–#102) and prove the
#96 acceptance criteria marked ❌ end to end through `runBenchmark` with the fake `claude`; no
registration in `createExecutableAdapters()` (#97).

## Plan

1. Contract: the engine passes the measured artifact (candidate) and the A/B baseline version in
   `AgentRunRequest`, because the argv of both variants depends on the candidate (`Skill(<name>)`,
   FR-118-08) and the adapter re-inspects both versions before every spawn (FR-118-26).
2. `claude-code/adapter.ts`: Zod-validated options, `detect()` from detection + readiness,
   `installArtifact()` = `installClaudeArtifact`, `run()` = inspections → locate + version check →
   argv/env → `runClaudeCode` → line-wise `ClaudeStreamParser` → `claudeRunOutcome`, one redacting
   exit.
3. Adapter unit tests (fake `claude` replaying recorded fixtures), engine e2e tests per ❌ criterion.
4. Specs, backlog row, gate, PR, Codex review loop.

## Decisions

- **The engine passes the measured artifact to every agent run** (`AgentRunRequest.artifact`,
  `baselineArtifact`): the `Skill(<name>)` rule of both variants comes from the candidate
  (FR-118-08), and re-inspecting both versions in `run()` keeps a `none` baseline run from starting
  `claude` for a refused candidate (FR-118-26). Alternative rejected: constructing the adapter with
  the artifact (two sources of truth). Recorded in SPEC-118 §8.2 and SPEC-203 §4.2.
- **Auth mode, permission profile and budget are constructor options** chosen by the caller (CLI
  flags, suite approval), never by the suite; `agentOptions['claude-code']` must be absent or
  empty.
- **Refusal codes stay out of `STOP_CODES`** (`artifact-*`, `baseline-skill-name-differs`,
  `binary-not-found`, `version-unsupported`, `artifact-install-conflict`): every run is refused the
  same way before any start, so nothing is spent; FR-118-15 is unchanged.
- **A key shorter than 8 characters is `auth-missing`**: `redactSecrets` removes exact values only
  from 8 characters (`MIN_KNOWN_SECRET_LENGTH`, now exported by core), so a shorter key could reach
  the trace.

## Work performed

1. `claudeBinaryIssue` → `checkClaudeBinary` shared by readiness and the adapter;
   `CLAUDE_CODE_AGENT` descriptor exported; `ClaudeRunOutcome` made a discriminated union.
2. `ClaudeCodeAdapter` (`claude-code/adapter.ts`) and the contract/engine change (commit
   `dd48ca0`), adapter unit tests with a `replay` mode of the fake `claude`.
3. Engine end-to-end tests `packages/benchmark-engine/test/claude-code-adapter.test.ts`
   (commit `8405939`).
4. SPEC-118 §8.2/§20/§21, SPEC-203 §4.2/§13, backlog row E06-S03-T05.

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — pass, 100% coverage in every
  package (agent-adapters 323 tests, benchmark-engine 388).
- `pnpm build && pnpm verify:pack` — pass.
- Red first (mutations of `adapter.ts`, reverted): without the bundle re-inspection in `run()`
  13 of 33 engine e2e tests fail; without the key as known secret 1 engine and 3 adapter tests fail
  (the planted key has no known token shape, so only exact-value redaction removes it).
- 2-core load (`taskset -c 0,1` with two `yes` loops): both new test files pass.
- Real binary (read-only, no session): `ClaudeCodeAdapter.detect()` against the installed
  `claude` 2.1.302 reports installed, subscription ready, api-key `auth-missing`; `run()` with a
  `.claude/settings.json` workspace, a hooks candidate and an `@/etc/hostname` import ends
  `workspace-contains-claude-config`, `artifact-executes-code` and `workspace-imports-outside`
  before any session.
- Not verified: a real `claude` session (AC-22, #103), the CLI wiring and plan-time refusals
  (#97), Windows.

## Problems and deviations

- The engine's snapshot after installation (`buildManifest`: no symlinks, ≤ 5 000 files,
  ≤ 100 MiB) refuses a `setup` symlink and oversized file sets before the adapter's pre-spawn
  scan (infrastructure-error without a stop code); `WORKSPACE_SCAN_MAX_FILES` is reached first only
  through directories. In an A/B run a fixture with a root `.claude` fails both installations
  (`artifact-install-conflict`) before the pre-spawn check. Both are refused at plan time by #97.
- The fake `claude` did not answer the readiness probe's `--setting-sources … auth status` form;
  added.

## Lessons recorded

## Follow-ups
