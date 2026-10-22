---
title: A/B baseline storage, agent-profile comparability, CLI-owned jobs and the web guard (SPEC-118 Phase 2)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: om-auto-fix-issue 95 (E06-S02), feature route → om-auto-implement-spec → om-auto-create-pr
status: completed
branch: feat/issue-95-ab-baseline
specs: [SPEC-118, SPEC-107, SPEC-111, SPEC-112, SPEC-114, SPEC-115]
---

# Run: A/B baseline storage and guards (SPEC-118 Phase 2, issue #95)

Source doc: .ai/specs/2026-10-22-benchmark-own-skills-s1.md

## Objective

Implement SPEC-118 §21 Phase 2 for issue #95 (E06-S02), on the mock agent, without any real
adapter: a benchmark run may use another version of the same artifact as its baseline
(`RunBenchmarkInput.baselineArtifact`, FR-118-10…13), the baseline is stored on the run
(`benchmark_runs.baseline_artifact_version_id`, §8.1), the comparability key gains
`agentProfile` only when one is reported (§8.3, AC-5), `config.json` carries a generated
`installationId` (SPEC-115), a job can be created already acquired by its runner and run
in-process (FR-118-34, AC-9), and the web app refuses to enqueue a non-mock suite (FR-118-05/53,
AC-19 first half).

Acceptance criteria used: the six Given/When/Then criteria of issue #95 (AC-3, AC-5, AC-9,
AC-19 first half, FR-118-12/13, §8.1 payload).

Non-goals: the Claude Code adapter (Phase 3), the `benchmark` CLI commands (Phase 4), the
read-only results UI (Phase 5), the assertion registry and document assertions (issue #94,
Phase 1, in flight on another branch), three-way runs, `hostId` export/import.

## Plan

Goal: the mock path gains an optional A/B baseline end to end (engine → job → runner → stored
run), CLI-owned jobs that `serve` can never acquire, and a web refusal of non-mock suites — with
every existing mock comparability key byte-identical.

Risks: the migration (additive, nullable, must apply on existing databases); the acquired-job
path (must be one statement, never visible as `pending`); concurrency between a polling runner
and an acquired job; a comparability-key change that would split existing history (guarded by
a pinned-key test and a before/after `demo` comparison).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Engine

- [x] 1.1 Shared baseline rule in core, `baselineArtifact` in `assertRunnable` and `runBenchmark` (baseline variant installs the baseline version) — 894561d
- [x] 1.2 `AgentProfile` in `EnvironmentMetadata` and the comparability key; mock key byte-identical — 894561d

### Phase 2: Database and configuration

- [x] 2.1 Migration `baseline_artifact_version_id` + schema + `createBenchmarkRun` — a7821d9
- [x] 2.2 Job payload schema (baseline, auth mode, budget), reference checks, `createAcquiredBenchmarkJob` — 8644e37
- [x] 2.3 `installationId` in `config.json` and the SPEC-115 update — 3fd7398

### Phase 3: Runner

- [x] 3.1 Runner loads and re-validates the baseline and stores it on the run — f8c5213
- [x] 3.2 `LocalRunner.runAcquiredJob` and the concurrent-runner test — f8c5213, ea4768e

### Phase 4: Web guard

- [x] 4.1 Server action refuses non-mock suites; benchmark page shows "Run from the CLI"; unit and Playwright tests — b698857

### Phase 5: Verification and documentation

- [x] 5.1 Quality gate, `demo` before/after key comparison, SPEC-118 §20 and related spec statuses, lessons — see the docs commit

## Decisions

- **One shared baseline rule** (`baselineArtifactIssue` in `packages/core`): the engine
  (`assertRunnable`), the job repository and the runner check FR-118-12 with the same function, so
  the rule cannot drift between "before a job exists" and "when the runner loads it". `database`
  and `benchmark-engine` do not depend on each other, so `core` is the only common place.
- **`AgentProfile` as a discriminated union**: `hostId` exists only on the `user-profile`
  variant, so "installationId is the hostId only for user-profile" is enforced by the type; no
  builder that maps `installationId` into a profile was added, because no adapter reports a
  profile before Phase 3 (no speculative helpers, SPEC-014).
- **Composite index `(artifact_version_id, baseline_artifact_version_id)`**, read from §8.1
  "index with `artifact_version_id`".
- **`installationId` for existing data directories**: added at the next initialisation with the
  file's other keys kept as written (no defaults frozen into it); recorded as SPEC-115 FR-115-15.
- **`createAcquiredBenchmarkJob(db, payload, runnerId, now)`** takes `now` explicitly (§10
  signature) and checks references itself; Phase 4 calls it inside the FR-118-39 transaction.
- **`runAcquiredJob` reuses the polled-job machinery** (`track`): the job is an active job of the
  long lane, so heartbeat, cancellation and `stop()` behave exactly as for polled jobs.
- **Web refusal message** names the agent and says running real agents from the CLI is planned —
  the `benchmark run` command does not exist yet, so the page marks the command "Planned — not
  implemented yet" (AGENTS.md §7).
- **Playwright test added** although the issue defers the benchmark-page check to E06-S05:
  AGENTS.md §2.7 requires one for every new UI path.

## Work performed

1. Plan and draft PR #106 (6831147).
2. Engine: `baselineArtifact`, the shared rule, `AgentProfile`, key with optional profile and a
   pinned mock-example key (894561d, 7691d60).
3. Database: migration 0002 with up/down test, `createBenchmarkRun` baseline (a7821d9); payload
   schema, reference checks, `createAcquiredBenchmarkJob` (8644e37).
4. Config: `ensureInstallationId`, CLI initialisation, SPEC-115/SPEC-010 (3fd7398).
5. Runner: baseline loading and re-validation, `runAcquiredJob`, AC-9 concurrency test
   (f8c5213, ea4768e).
6. Web: `webRunBlockers`, "Run from the CLI" card, unit and Playwright tests (b698857).
7. Spec statuses (SPEC-118 §20, SPEC-107, SPEC-111, SPEC-112, SPEC-114, SPEC-115), lesson, this log.

## Verification

Before any change, `directivebench demo` on `origin/main` (c7576e6) stored comparability key
`8212a3ebe5818fbf2413bfd7671874710a362f4f5fde0b20c53f77174a8e0f9f` for the bundled mock example.

| Command | Result |
| --- | --- |
| `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` | pass; 100% statements/branches/functions/lines in core (256 tests), database (131), benchmark-engine (115), runner (229), web (157), cli (75), agent-adapters |
| `pnpm build && pnpm verify:pack` | pass ("Packaging verification passed") |
| `pnpm test:e2e` | 38 passed, including the new non-mock suite test |
| `directivebench demo` (built CLI, fresh data dir) | verdict improved; stored key `8212a3eb…0f9f` — byte-identical to the key before the change (AC-5) |
| `directivebench init` on the data dir created by `main` | 1 migration applied; the old run reads `baseline_artifact_version_id = null`; `config.json` kept every key and gained only `installationId` |
| Live AC-9 + A/B check: `directivebench serve` on the demo data dir; a script (scratchpad, `tsx`) imported v1 of the skill, created an acquired A/B job in a transaction and ran it with `runAcquiredJob` | job completed, run `improved` with `baseline_artifact_version_id` = v1 and the same key; the job kept the script's runner id; `serve` wrote no runner event (no `acquired`) |
| Red-first: `createAcquiredBenchmarkJob` inserting `pending` (temporary mutation) | the AC-9 test fails (`JobNotAcquiredError`), restored afterwards |

Not verified: anything that needs a real agent (`agentProfile` reported by an adapter,
`installationId` used as `hostId` in a stored key), and the CLI parts of AC-3/AC-9 (`benchmark run
--baseline`), which are Phase 3–4. Windows was not run.

## Problems and deviations

- The existing `0001_add_job_result` migration test migrated "up" to the full migrations folder;
  adding 0002 broke it. Fixed by pinning it to its own journal prefix (lesson below).
- `pkill -f` with the serve command line also matched the shell running it (known lesson
  2026-10-14); `serve` still shut down cleanly.
- `f8c5213` already contains the `runAcquiredJob` code (both changes were in `runner.ts`); its
  tests are in `ea4768e`.
- The shared session scratchpad let the parallel #94 agent overwrite this run's `pr-body.md`;
  PR #106 briefly showed #94's description and was restored (second lesson below).
- No deviation from SPEC-118. The index layout (composite) is an interpretation of §8.1.

## Review

Round 1 (independent `om-code-review` agent, head `ed3f0ab`): changes requested — major: the A/B
runner test asserted job order although both jobs could share a `createdAt` millisecond (failed
2/13); minors: SPEC-118 §20 overstated `EnvironmentMetadata.agentProfile`, `ensureInstallationId`
overclaimed its race behaviour and replaced a symlinked `config.json`, the enqueue check-then-act
was undocumented; nit: the long lane may exceed `concurrency`. All fixed in the review-fix commit:
results matched by job id (15/15 runs pass), the status reworded, symlinks written through (new
test) and the race documented, comments added. Full gate re-run: pass, 100% coverage.

## Lessons recorded

- [2026-10-22 — Pin each migration's up/down test to its own journal prefix](../lessons/2026-10-22-pin-migration-tests-to-their-journal-prefix.md)
- [2026-10-22 — Parallel agents of one session share the scratchpad](../lessons/2026-10-22-parallel-agents-share-the-scratchpad.md)

Review round 2 (`25f2190`): approve; CI green on `25f2190`.

## Follow-ups

- Phase 3 (Claude Code adapter) reports `agentProfile` and sets `hostId` from `installationId`
  for `user-profile` runs; Phase 4 (`benchmark run`) calls `createAcquiredBenchmarkJob` inside the
  FR-118-39 transaction and `runAcquiredJob`, and maps SIGINT to `cancelled` (FR-118-36: today
  only a cancellation request or `stop()` aborts an acquired job).
- Merging with #94 (assertion registry) may touch `orchestrator.ts` near the assertions loop.
