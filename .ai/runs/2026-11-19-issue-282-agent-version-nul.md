---
title: Issue 282, agent --version line with U+0000 no longer fails the run
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #282 (maintainer approved), om-auto-fix-issue
status: completed
branch: fix/issue-282-agent-version-nul
specs: [SPEC-006, SPEC-203, SPEC-111]
---

# Run: Issue 282, agent --version line with U+0000 no longer fails the run

## Objective

No `--version` output of an agent CLI may reach the database guard `NulInTextError`; the stored
`benchmark_runs.agent_version` is defined and tested (issue #282).

## Plan

1. Phase A: trace every value from agent detection, `--version`, readiness and `doctor` that reaches
   a TEXT column, read what the specs say `agent_version` holds, and decide.
2. Red-first tests (repository and a real `benchmark run` with a fake `claude` printing U+0000).
3. Fix at the repository boundary, update SPEC-006, gate, real run with the built CLI, Codex
   adversarial review, draft PR, `om-auto-review-pr`.

## Decisions

Traced paths:

- `readVersionLine` (`packages/agent-adapters/src/probe.ts`) returns the first non-empty stdout
  line of `--version`, cut to 200 characters. `detectCliAgent` puts it into `detection.version`
  unchanged; the Claude Code adapter's `detect()` returns that detection.
- Stored: `LocalRunner` (`packages/runner/src/runner.ts`) passes `detection.version` to
  `createBenchmarkRun` → `benchmark_runs.agent_version` (TEXT). This is the only TEXT column it
  reaches.
- The issue's "CLI path" is not a second storage path: `directivebench benchmark run`
  (`apps/cli/src/benchmark-run.ts`) shows `readiness.version` (parsed `x.y.z`) only in the plan
  text, then runs the job through the same `LocalRunner.runAcquiredJob`, which stores the raw line.
  So the CLI path stores the raw line today too.
- Not stored as TEXT: `environment.adapterVersion` (JSON in `summary`), the comparability key (a
  SHA-256 over canonical JSON of the raw line), warnings (JSON), readiness details and `doctor`
  output (shown only; the Agent Connections page renders `detection.version` live). JSON escapes
  U+0000 as `\u0000`, so those are safe.

Option chosen: keep the raw line and normalise U+0000 to U+FFFD (option 2), in
`createBenchmarkRun` through `storedMessage`. Why it is determined by existing behaviour, not a
product choice:

- SPEC-006 already treats `agent_version` as free text whose U+0000 becomes U+FFFD: migration
  `0010_text_without_nul` rewrites exactly that in `benchmark_runs.agent_version`. New rows now
  match what the migration made of old ones.
- Storing the parsed version would change what every existing run shows (`2.1.302 (Claude Code)`
  becomes `2.1.302`) in the results page, the artifact runs table and the export, would diverge
  from the comparability key (which hashes the raw line; changing it would split comparability with
  all stored history), and has no definition for adapters without a parser (mock, codex, cursor).
- A clean line is stored byte-identically, so nothing changes for any version line without U+0000.

## Work performed

- Red-first tests: `packages/database/test/runs.test.ts` (repository) and
  `apps/cli/test/benchmark-run.test.ts` (real `benchmark run` with a fake `claude` whose
  `--version` prints `2.1.302\0 (Claude Code)`); `writeFakeClaude` takes an optional `printf`
  format for `--version`.
- Fix: `createBenchmarkRun` writes `agentVersion` through `storedMessage`.
- SPEC-006 §1 Text, the `agent_version` column note and Implementation status updated.

## Verification

All on Node 24 (local), `TMPDIR=/var/tmp/issue282-*`:

| Command | Result |
| --- | --- |
| Red first: `vitest run test/runs.test.ts -t "issue 282"` (database) before the fix | failed: `Failed query: insert into "benchmark_runs"` (the client's `NulInTextError`) |
| Red first: `vitest run test/benchmark-run.test.ts -t "issue 282"` (cli) before the fix | failed: `CliError: The benchmark job failed: The benchmark run failed unexpectedly.` |
| Both after the fix | passed |
| `pnpm lint` | passed |
| `pnpm typecheck` | passed |
| `pnpm exec turbo run test --force` | 7/7 tasks; 2837 passed, 2 skipped; 100% coverage in every package |
| `pnpm build` / `pnpm verify:pack` | passed / "Packaging verification passed" |
| Real run: built `apps/cli/dist/cli.js` `demo`, then `benchmark run` of a one-case suite against `validate-external-input` with a fake `claude` on `PATH` whose `--version` prints `2.1.302\0 (Claude Code)` | exit 0, `Result: passed (verdict: unchanged)`; `benchmark_runs.agent_version` = `2.1.302\uFFFD (Claude Code)` (code points checked), status `completed` |
| Codex adversarial review, round 1 | approve, no material findings |

Not verified: Node 22.16 locally (no SQL changed; CI `oldest-node` covers it), Windows, a real
`claude` binary (never started, per the brief).

## Problems and deviations

- The issue says the CLI path stores the parsed `readiness.version`; it only displays it. Both
  paths store through the runner.

## Lessons recorded

None: the fix applies the existing `storedMessage` rule; nothing non-obvious was learned beyond
the trace above.

## Follow-ups

- `pnpm test -- --force` does not bypass the turbo cache: the flag reaches Vitest, which rejects
  it (`Unknown option --force`). `pnpm exec turbo run test --force` works. Relevant to #281.
