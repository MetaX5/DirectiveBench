---
title: Claude Code stream parser, error normalisation and the engine's model/activation/stop rules (issue #100)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 100 (E06-S03-T02, SPEC-118 Phase 3 step 2)
status: completed
branch: feat/issue-100-stream-parser
specs: [SPEC-118, SPEC-203, SPEC-111, SPEC-112]
---

# Run: Claude Code stream parser and engine rules (issue #100)

## Objective

Turn `claude -p --output-format stream-json` output into an agent-run record (execution model,
reported and auxiliary models, per-message model, `skillActivation`, permission denials, usage,
SPEC-203 §9 error codes) and make the engine refuse comparisons across execution models, apply
the skill-activation rules and stop on systematic failures. Done when (issue #100): FR-118-04
metadata and FR-118-09 `skillActivation` from recorded fixtures; §9 codes; FR-118-15 stop codes;
`execution-model-mismatch` → `not-comparable`; `auxiliary-models` warning;
`baseline-invoked-tested-skill`; AC-17, AC-18, AC-21, AC-25 and the stream part of AC-28 at the
parser/engine level; 100% coverage.

## Plan

1. `packages/agent-adapters/src/claude-code/stream-parser.ts` — incremental NDJSON parser
   (`push(chunk)`/`end()`), bounded by named limits (line bytes, events, stored trace events and
   text, models and skill names), linear in input, redacting every stored text; produces trace
   events, init facts (model, tools, skills, `apiKeySource`), main-conversation message models,
   `modelUsage` keys, usage, permission denials, API error categories, result.
2. `normalize.ts` — `classifyClaudeRun(parsed, exit)`: status, SPEC-203 §9 code, message and
   warnings (`auth-mismatch` from `apiKeySource`, API error categories, result subtypes, auth/quota
   texts, `output-parse-error`, `cli-usage-error`, `agent-reported-error`, `permission-denied`).
   `skillActivation` for `skill-md` (loaded / invoked / `/<name>` with expansion evidence /
   other skills).
3. Contract (`contract.ts`, SPEC-203 §4.2): `AgentRunResult` gains optional `errorCode`,
   `warnings`, `metadata`, `skillActivation`; `AgentExecutionStatus` gains `infrastructure-error`;
   new trace event variants.
4. Engine (`packages/benchmark-engine/src/agent-conditions.ts`, small hooks in
   `orchestrator.ts`): per-run `agent-metadata` trace event; FR-118-15 stop codes and FR-118-09 (a)
   → `BenchmarkStoppedError`; (b) `artifact-not-invoked` + invocation rate; (c)
   `baseline-invoked-tested-skill`; FR-118-04 equivalence of the agent conditions across all runs,
   `execution-model-mismatch`, `auxiliary-models`; `agentProfile` in the environment and key.
5. Fixtures under `packages/agent-adapters/test/fixtures/claude-code/`, tests, 2-core timing check,
   spec status, PR, review loop.

Boundary with #101 (process control, in parallel): #101 owns spawning, stdin, timeout/cancel,
process groups and the pre-spawn workspace pin; this run owns the parser/normaliser modules and
the engine's comparability/activation/stop rules. Shared touch points: `contract.ts` (additive) and
`orchestrator.ts` (one hook after the adapter result).

## Decisions

- **Evidence from the binary, not a session.** Field names were taken from the stream schemas
  compiled into the local `claude` 2.1.302 (read with `strings`; no session, no credential) and
  recorded as SPEC-203 evidence L3: init `apiKeySource` (`none` for a claude.ai login,
  `ANTHROPIC_API_KEY` for the key), init `skills`, assistant `error` categories, `Skill` input
  `skill`, `forked-command-<name>`. The fixtures are constructed in that format and say so; AC-22
  replaces them with recordings.
- **Auth-source check fails closed:** a missing or unexpected `apiKeySource` is `auth-mismatch`
  (a stop code). If the live check shows the field behaves differently, every run stops with a
  clear message rather than running under the wrong credentials.
- **Inline `/<name>` expansion signal** = a main-conversation user message before the first
  assistant message containing `<command-name>/<name></command-name>` (Assumption, AC-22); the
  forked signal is any `parent_tool_use_id` starting with `forked-command-` (spec + L3).
- **Synthetic assistant messages** (`message.model` `<synthetic>`, CLI-written errors) are not
  model output: they do not count as a model, their text is a failure text.
- **A recovered retry does not classify a failure:** the last `api_retry` category counts only
  when the run ended without a regular error subtype; the assistant `error` category always counts.
- **Engine, not adapter, decides artifact-not-loaded / not-invoked** — only the engine knows the
  variant and baseline kind (a `none` baseline is expected to have nothing loaded).
- **Stop = exception after persisting:** `BenchmarkStoppedError` after `onAgentRun`, so the
  failing agent run is stored and the runner's existing error path ends the benchmark run `error`
  with the reason; no runner change was needed.
- **Agent-profile key when runs disagree:** first reporting run's fields with the sorted set of
  observed models as `executionModel`; `user-profile` without `hostId` → `not-comparable`
  `host-id-missing` (fail closed) instead of an unkeyed profile.
- **auxiliary-models** warns when the auxiliary sets differ between runs (AC-18 wording), not
  whenever an auxiliary model exists; per-run sets stay in the `agent-metadata` trace event.
- Cost is dropped in subscription mode ("n/a (subscription)"), kept (an estimate) in api-key mode.

## Work performed

1. Contract extension (`contract.ts`): `AgentRunResult.errorCode/warnings/metadata/skillActivation`,
   status `infrastructure-error`, trace events `tool-call`/`tool-result`/`permission-denied`/`retry`,
   cache token fields.
2. `claude-code/stream-parser.ts` and `normalize.ts` with 23 fixtures under
   `packages/agent-adapters/test/fixtures/claude-code/2.1.302/` and their tests.
3. `benchmark-engine/src/agent-conditions.ts`, hooks in `orchestrator.ts` (`agent-metadata` trace
   event, activation rules, stop, condition issues/warnings, observed profile, `hostId` input,
   `summary.skillInvocation`); runner test for the stop path.
4. Self-review fix: every name from the stream (model, `apiKeySource`, categories, subtype) is
   clipped to `CLAUDE_STREAM_NAME_MAX_CHARS`.
5. Merged origin/main (PR #105, document assertions); resolved the SPEC-118 §20 conflict; its
   `assertion-error` path now also sets `errorCode: 'assertion-error'`.
6. SPEC-118 §20 and SPEC-203 §13 (+ evidence L3) updated for verified behaviour only.
7. PR #111 opened; independent review round 1 (`e75c4df`, changes requested: 3 major, 4 minor)
   fixed with regression tests: M1 — a recovered retry or error (model answer afterwards) and a
   subagent's `error` no longer decide a later failure (`apiError` = last main message only,
   retries and synthetic texts cleared by a model answer); M2 — failure wording is matched
   anchored, line by line, only in CLI-written text, never in the agent's answer; M3 — the stderr
   tail and the dropped-line head are redacted before they are cut; m1 — only
   `forked-command-<name>` counts; m2 — comment corrected and an uncategorised synthetic error is
   `provider-error`; m3 — login/quota messages outside the JSON stream (stdout, stderr) map to
   their stop codes; m4 — cancelled/timed-out runs are exempt from `artifact-not-loaded`. Nit:
   the linear-time test takes the fastest of three with a named 60 s timeout (it had hit vitest's
   5 s default at load average 12 with parallel agents on the machine).
8. Review round 2 (`a50bcdc`): approve-equivalent; two minors fixed — a synthetic message without
   a category no longer clears the last API error category (regression test), and SPEC-203 §9's
   `is_error` rule now states the CLI-reported-failure exception. CI run 39786117837 on `a50bcdc`
   passed every job; CI on `e75c4df` had failed on this PR's timing test (5 s default timeout,
   fixed in `a50bcdc`) and once on #99's `import-tokens` ratio test (13 > 12), which passed on
   the next run.

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck` — pass.
- `taskset -c 0,1 pnpm test --force` (2-core CI emulation) on the merged head — pass, 100%
  coverage in every package (agent-adapters 246, benchmark-engine 287, runner 232 tests).
- Linear-time parser test 3× under `taskset -c 0,1` with two `yes > /dev/null` loads — pass.
- `pnpm build && pnpm verify:pack` — pass.
- Built CLI `directivebench demo` in a temp data dir: verdict `improved`, comparability key
  `8212a3eb…0f9f` (byte-identical to the pinned mock key), no `agent-metadata` event in mock traces.
- **Not verified:** any real `claude` stream (fixtures are constructed), the inline expansion
  signal, that `apiKeySource` is emitted as read, the spawning adapter (#101), CLI surfaces of the
  invocation rate (Phase 4/5).

## Problems and deviations

- A first full test run overlapped a source edit; it was discarded and the gate rerun.
- `grep -o` with context on the 285 MB binary failed ("exceeds complexity limits"); used `strings`
  + Python instead.
- Two CLI `doctor` tests timed out once (5 s) under load average ~12 from parallel agents; they
  pass in isolation and in the reruns, and are unrelated to this change.
- Deviation in naming: other differing agent conditions use the issue text
  `agent condition <field> differs …` (no separate code in the spec).

## Lessons recorded

- `.ai/lessons/2026-10-22-read-a-cli-stream-schema-from-its-binary.md`

## Follow-ups

- AC-22 live check: record real streams for these fixtures, confirm `apiKeySource`, `skills`,
  `Skill.input.skill` and the inline `/<name>` expansion message.
- #101: spawn `claude`, feed `ClaudeStreamParser.push` with stdout, call `claudeRunOutcome` with
  the exit code/stderr and add `durationMs`; report pre-spawn inspection failures as
  `infrastructure-error` with their code so the stop rule applies.
- #99's `import-tokens` linear-time test flaked once on CI (`@a@a…` ratio 13 vs bound 12 on
  run 39783979231); worth measuring at three sizes per the timing lesson.
- Spec decision for the maintainer: SPEC-203 §9 maps `overloaded` → `rate-limited`, a stop code,
  although a 529 is a transient server condition (review nit); kept as specified.
- Phase 4: pass `installationId` as `RunBenchmarkInput.hostId`; show `summary.skillInvocation`.
