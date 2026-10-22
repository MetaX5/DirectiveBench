---
title: benchmark init / benchmark run in the CLI with the Claude Code adapter (issue #97)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 97 (E06-S04, SPEC-118 Phase 4 steps 1–2)
status: in-progress
branch: feat/issue-97-benchmark-cli
specs: [SPEC-118, SPEC-203, SPEC-009, SPEC-107, SPEC-114]
---

# Run: `benchmark init` / `benchmark run` (issue #97)

Source doc: .ai/specs/2026-10-22-benchmark-own-skills-s1.md

## Goal

A skill author scaffolds a suite for a scanned artifact with `directivebench benchmark init
--artifact <ref>` and runs it with `directivebench benchmark run <suite> --artifact <ref>
[--version <n>] [--baseline none|v<n>] [--auth subscription|api-key] [--max-budget-usd <n>]
[--approve-commands] [--yes] [--json]` against their installed Claude Code, gets the plan with
cost and data-leaving notices, a verdict and an exit code (SPEC-118 §6.3, §6.4, §13, §14,
FR-118-20…39; Phase 4 steps 1–2).

## Scope

- **Built on #119 (Mateusz, issue #117).** The `ClaudeCodeAdapter` composing the Phase 3 pieces
  comes from PR #119; this branch is based on it and does not change the adapter. The CLI only
  creates it with the caller's options (auth mode, permission profile, budget) and registers it
  in the runner `benchmark run` starts (FR-118-05).
- `packages/database`: `resolveArtifactRef`, one transaction that records fixture versions,
  imports the suite version, records approval `user` and creates the acquired job (FR-118-39,
  FR-118-33/34), `approveSuiteVersion`.
- `packages/runner`: `hostId` passed to `runBenchmark` (§8.3), cancelling an active job in-process
  (FR-118-36).
- `apps/cli`: `benchmark init`, `benchmark run`, plan text, confirmation, summary, `--json`, exit
  codes, SIGINT, assignment (FR-118-24); integration tests with a fake `claude` (NFR-118-01).
- Docs: SPEC-118 §20, SPEC-203 §13, SPEC-009 §2, README, the web empty state that calls
  `benchmark init` "planned".

## Non-goals

- The opt-in live check with a real `claude` (Phase 4 step 3, AC-22, issue #103): needs a human
  with real credentials. Not done here and not marked done; #97 cannot ship to users before it.
- Running from the UI, the builder, `benchmark list`, export, a subscription cost cap (§19).
- `serve` stays mock-only (FR-118-05).
- Other agents than `claude-code` in `benchmark run` (the mock suite path is `demo`).

## Implementation Plan

### Phase 1: Database and runner

1. `resolveArtifactRef(db, ref, version?)`: id, then slug; version number; unknown → closest
   matches; one-version artifact for `--baseline vN`.
2. `createBenchmarkRunJob(handle, …)`: one `withTransaction` that records fixture versions,
   imports the suite version (shared body with `importSuiteVersion`), approves it with source
   `user` when asked (`approveSuiteVersion`, one conditional UPDATE) and inserts the acquired job;
   any failure rolls everything back.
3. Runner: `LocalRunnerOptions.hostId` → `RunBenchmarkInput.hostId`; `cancel(jobId)` aborts an
   active job as a user cancellation.

### Phase 2: CLI

4. `benchmark init --artifact <ref>`: slug normalised to the suite-id pattern, folder confined to
   the current directory, refuses a non-empty target, writes the commented `benchmark.yaml` and
   `fixtures/example/README.md`, writes nothing to the database.
5. `benchmark run` preparation: argument checks (`--baseline`, `--version`, `--max-budget-usd`
   only with `--auth api-key`), suite load and fixture snapshot, artifact and baseline resolution,
   type/format checks, bundle inspection, skill-name equality, slash-prompt refusal, command
   approval, fixture/overlay configuration refusal and the plan-time import scan, readiness — all
   before any database change (FR-118-39).
6. Plan text and notices, confirmation (TTY / `--yes` / refuse), `--approve-commands` argv listing,
   the final transaction, the in-process run with SIGINT → cancel → 130, summary and `--json`,
   exit codes, assignment.
7. Register `benchmark init` and `benchmark run` in `main.ts`; `doctor` and the web empty state
   stop calling execution "not implemented" / "planned".
8. Integration tests with a fake `claude` on `PATH`: subscription and api-key (env and planted
    key), A/B, refusals leave the database unchanged, unchanged suite reused, exit codes, SIGINT.

### Phase 3: Docs and verification

9. SPEC-118 §20 / §16 for verified criteria only, SPEC-203 §13, SPEC-009 §2, README; lessons.
10. Real-app run of the built CLI (`benchmark init` and `benchmark run` with the fake `claude`
    against a scanned local repository) and the full gate.

## Risks

- `risk-high` (SDLC.md): authentication modes, cost consent and command approval. The live
  behaviour of the real CLI is only covered by #103.
- Depends on #119: if its adapter API changes in review, the CLI's construction of the adapter
  follows it on rebase. The PR is retargeted/rebased onto `main` once #119 merges.
- Timing-sensitive tests on 2-core CI (#114): use injected signals and fakes, not wall-clock waits.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Database and runner

- [x] 1.1 resolveArtifactRef — 42714d9
- [x] 1.2 One-transaction suite import, approval and acquired job — d985ad6
- [x] 1.3 Runner hostId and in-process cancel — e8e2b86

### Phase 2: CLI

- [ ] 2.1 benchmark init
- [ ] 2.2 benchmark run preparation and refusals
- [ ] 2.3 Plan, confirmation, run, summary and exit codes
- [ ] 2.4 Register commands and update doctor and web copy
- [ ] 2.5 CLI integration tests with a fake claude

### Phase 3: Docs and verification

- [ ] 3.1 Specs, README and lessons
- [ ] 3.2 Real-app run and full gate

## Decisions

- 2026-10-22: the first two commits of this run built a `ClaudeCodeAdapter` too; PR #119 (issue
  #117, opened in parallel by the maintainer) builds it more completely. To avoid duplicate work
  the branch was rebuilt on #119 and those commits dropped; #97 is claimed on the issue.

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
