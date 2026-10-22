---
title: Claude Code stream parser, error normalisation and the engine's model/activation/stop rules (issue #100)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 100 (E06-S03-T02, SPEC-118 Phase 3 step 2)
status: in-progress
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

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
