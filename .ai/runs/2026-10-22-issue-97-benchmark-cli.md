---
title: benchmark init / benchmark run in the CLI with the Claude Code adapter (issue #97)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 97 (E06-S04, SPEC-118 Phase 4 steps 1–2)
status: completed
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

- [x] 1.1 resolveArtifactRef — 458fadb
- [x] 1.2 One-transaction suite import, approval and acquired job — 77405d2
- [x] 1.3 Runner hostId and in-process cancel — b23f307

### Phase 2: CLI

- [x] 2.1 benchmark init — 6d1b2d9
- [x] 2.2 benchmark run preparation and refusals — b5b8ab6
- [x] 2.3 Plan, confirmation, run, summary and exit codes — b5b8ab6
- [x] 2.4 Register commands and update doctor and web copy — b5b8ab6, 87dcdf5
- [x] 2.5 CLI integration tests with a fake claude — b5b8ab6

### Phase 3: Docs and verification

- [x] 3.1 Specs, README and lessons — fc07724, 349fe66
- [x] 3.2 Real-app run and full gate — this commit

## Decisions

- 2026-10-22: the first two commits of this run built a `ClaudeCodeAdapter` too; PR #119 (issue
  #117, opened in parallel by the maintainer) builds it more completely. To avoid duplicate work
  the branch was rebuilt on #119 and those commits dropped; #97 is claimed on the issue. After
  #119 merged, the branch was rebased onto `main`.
- The CLI chooses the adapter's options (auth mode, budget); the permission profile stays
  `edit-only`, because S1 has no flag for `edit-and-shell` and #119 refuses any
  `agentOptions['claude-code']`. `benchmark run` refuses a non-empty one at plan time.
- `benchmark run` executes `claude-code` suites only; a mock suite is refused with a pointer to
  `demo` and the web UI.
- The artifact version flag is `--artifact-version`, not `--version` (Commander's program
  `--version` takes it first; positional options would break `--data-dir` after a subcommand).
  SPEC-118 FR-118-22/30 and §14 changed in this change set.
- A declined confirmation exits 130 (treated as a cancellation) and stores nothing.
- `importSuiteVersion` keeps its own transaction; its body is shared with the new
  `createBenchmarkRunJob`, which wraps fixture versions, suite version, approval and the acquired
  job in one `withTransaction` (FR-118-39).
- With `--json` the plan goes to stderr, so stdout holds only the result object.
- Plan-time inspection resolves `~` against the real `HOME` in subscription mode and against a
  fresh empty directory in API Key Mode, as the adapter's run-local home is empty.

## Work performed

1. Database: `resolveArtifactRef` (+ `ArtifactRefError` with closest slugs or versions),
   `createBenchmarkRunJob`, `approveSuiteVersion`, `suiteVersionApproval`.
2. Runner: `LocalRunnerOptions.hostId` → `RunBenchmarkInput.hostId`; `LocalRunner.cancel(jobId)`.
3. CLI: `benchmark init` (`benchmark-init.ts`), `benchmark run` (`benchmark-plan.ts`,
   `benchmark-run.ts`), both registered in `main.ts`; `doctor`, detection notes and three web
   texts no longer call Claude Code execution planned.
4. Tests: `packages/database/test/artifact-ref.test.ts`, `benchmark-run-job.test.ts`,
   `packages/runner/test/runner-acquired.test.ts` (cancel, hostId),
   `apps/cli/test/benchmark-init.test.ts`, `benchmark-run.test.ts` (fake `claude` on `PATH`,
   `test/support/fake-claude.ts`, replaying the recorded-format streams of agent-adapters),
   `benchmark-report.test.ts`, `main.test.ts`; e2e expectations for the changed texts.
5. Docs: SPEC-118 §6.3/§6.4/§14/§16/§20, SPEC-009 §2 and status, README, AGENTS.md §4 (review
   rule), two lessons.

## Verification

| Check | Result |
| --- | --- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` (Linux, Docker `node:24`, 2 CPUs) | pass |
| `pnpm test` (Linux, non-root) | core 266, database 149, agent-adapters 348, benchmark-engine 398, CLI 123 tests pass at 100% coverage; runner: only the hosted-git tests fail (the image's git 2.39 < 2.44, which they need; `runner-acquired.test.ts` passes); web: 1 linear-time test (#114) — CI on GitHub is authoritative |
| `pnpm test` (macOS) | the new tests pass; the pre-existing macOS failures listed below |
| `pnpm build && pnpm verify:pack` (Linux) | pass |
| `pnpm test:e2e` (macOS) | 44/44 pass |
| Real app: built CLI, fresh data dir, `demo` → `benchmark init --artifact validate-external-input` → `benchmark run … --yes` with a fake `claude` on `PATH` | 6 agent runs, `passed`, exit 0; without TTY and `--yes`: exit 2 |
| Real app: Ctrl-C with a fake `claude` ignoring SIGINT/SIGTERM | exit 130 after 5 s, run `cancelled`, no `claude` process left |

Not verified: a real `claude` session in either auth mode (#103), Windows.

## Problems and deviations

- Plan deviation: Phase 1 of the first plan (the adapter) was dropped for #119 (see Decisions).
- On this macOS machine, independent of this change and also failing on `main`:
  `packages/agent-adapters` `process.test.ts` (2) and `run.test.ts` (1) — `setsid` missing and a
  kill-grace race (issue #120); `packages/runner` `hosted-repository.test.ts` "rejects a file name
  that is not valid UTF-8" (APFS refuses such names); `apps/cli` `cli.test.ts` "warns with a hint
  when the data directory does not exist yet" — with a real `claude` installed and no auth mode
  ready, `doctor` reports `warn` without a hint (a real, small defect; follow-up).
- `pnpm build` needs `pnpm` on `PATH` for turbo; with pnpm only through corepack, a shim from
  `corepack enable --install-directory <dir> pnpm` was used.

## Codex adversarial review, round 1 (`om-auto-fix-pr`, 2026-10-22)

Both medium findings of the review on `f4fa96b`
([comment](https://github.com/MetaX5/DirectiveBench/pull/118#issuecomment-6350229110)) fixed;
the maintainer chose option (a) for the first, so FR-118-39 is unchanged in substance.

1. **Writes before validation and consent.** `benchmark run` no longer calls `initialize()`
   first: `openInitializedDatabase` (`apps/cli/src/setup.ts`) opens an existing, fully migrated
   database read-only for every check; a missing database or one with pending migrations exits 2
   naming `directivebench init`, an unreadable one exits with the data-directory code, and
   `initialize()` runs only after the confirmation. `config.json` is validated read-only before
   the plan. The migration count is shared with `doctor` (`migrationStatus`).
2. **Readiness accepting unusable API keys.** `claudeApiKeyIssue` (agent-adapters) is the one
   structural check (≥ 8 characters, one line, no NUL) used by readiness and `buildClaudeEnv`.

| Check | Result |
| --- | --- |
| Red first: the 5 new tests (fresh dir, older DB, unreadable DB, short/multi-line key in CLI and in readiness) on the old code | 5 fail; pass with the fix |
| `pnpm format:check && pnpm lint && pnpm typecheck` (macOS) | pass |
| `pnpm test` (macOS) | CLI 129 tests: all pass except the known `doctor` hint test (see above), 100% coverage; agent-adapters: only the known macOS process tests (#120) fail, the changed files are at 100%; core, database, web (except #114) pass; benchmark-engine (untouched by this PR) is SIGKILLed on this machine — CI on Linux is authoritative |
| `pnpm build && pnpm verify:pack` (macOS) | pass |
| Real app, built CLI: `benchmark run` on a fresh `--data-dir` | exit 2, "run `directivebench init` first", directory not created |
| Real app: `ANTHROPIC_API_KEY=abc` and a two-line key, `--auth api-key --yes` | exit 2 `auth-missing` at readiness, no job |
| Real app: a database with a migration record removed (simulated older DB) | exit 2 `2/3 migrations applied`; migration, category and job counts unchanged |

Not verified: a real older release's data directory (simulated by a journal prefix in tests and
a removed migration record in the real-app run), Windows.

Lesson: `.ai/lessons/2026-10-22-refusals-start-from-a-fresh-and-an-old-data-dir.md`.

## Codex adversarial review, round 2 (`om-auto-fix-pr`, 2026-10-22)

Both medium findings on `2bb5932`
([comment](https://github.com/MetaX5/DirectiveBench/pull/118#issuecomment-6350708456)) fixed:

1. **Model validated only per run.** A suite whose `execution.model` was
   `{ provider: openai, … }` or had an unsafe name was stored and approved, and its `setup` ran
   for every run before the adapter refused. `checkSuite` now calls the adapter's own
   `claudeModelArgs` (exported from `argv.ts`, the same code `buildClaudeArgv` uses), so both
   cases exit 2 before anything is stored or any `setup` runs.
2. **EOF at the confirmation hung.** `readline/promises` `question()` never settles when input
   ends, so `askYesNo` now races it against the interface's `close` event: Ctrl-D or a closed
   stdin is a no, exit 130, and the staged fixture copies are removed.

| Check | Result |
| --- | --- |
| Red first: the 3 new tests (model provider and name, EOF/Ctrl-D in `askYesNo`, EOF end to end) on the old code | 3 fail (two by hanging until the 5 s timeout); pass with the fix |
| `pnpm format:check && pnpm lint && pnpm typecheck` (macOS) | pass |
| `pnpm test` CLI (macOS) | 131/132, 100% coverage; the one failure is the known `doctor` hint test |
| `pnpm test` agent-adapters (macOS) | only the known #120 process tests fail |
| `pnpm build && pnpm verify:pack` (macOS) | pass |
| Real app, built CLI in a pty: Ctrl-D at "Start the benchmark run? [y/N]" | exit 130, "Not started; nothing was stored.", no new staging directory, no job |
| Real app: the scaffolded suite with `model: { provider: openai, model: gpt-x }` | exit 2 `Refused (model-provider-unsupported)`, no job |

Lesson: `.ai/lessons/2026-10-22-readline-question-never-settles-on-eof.md`.

## Lessons recorded

- `.ai/lessons/2026-10-22-review-prs-through-om-auto-review-pr.md` (human correction; also a rule
  in AGENTS.md §4)
- `.ai/lessons/2026-10-22-commander-version-flag-shadows-subcommands.md`
- `.ai/lessons/2026-10-22-refusals-start-from-a-fresh-and-an-old-data-dir.md`
- `.ai/lessons/2026-10-22-readline-question-never-settles-on-eof.md`

## Follow-ups

- #103: the opt-in live check with a real `claude` in both auth modes (AC-22) before the slice
  ships to users.
- `doctor`: a Claude Code readiness `warn` (no auth mode ready) has no remediation hint, breaking
  the "every non-ok check has a hint" rule of SPEC-009 §4.
- #120: macOS and Windows CI gates (the macOS failures above).
