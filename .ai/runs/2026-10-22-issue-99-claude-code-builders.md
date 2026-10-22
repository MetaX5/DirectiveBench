---
title: Claude Code adapter pure builders and pre-spawn inspection (SPEC-118 Phase 3 step 1)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: om-auto-fix-issue 99 (E06-S03-T01), feature route → om-auto-implement-spec → om-auto-create-pr
status: in-progress
branch: feat/issue-99-claude-code-builders
specs: [SPEC-118, SPEC-203]
---

# Run: Claude Code pure builders and pre-spawn inspection (issue #99)

Source doc: .ai/specs/2026-10-22-benchmark-own-skills-s1.md

## Objective

Implement SPEC-118 §21 Phase 3 step 1 for issue #99 (task of story #96): deterministic pieces of
the Claude Code adapter that decide what runs and refuse everything that could widen the profile
or reach host files, before any `claude` process starts. No process is spawned, no network, no
credentials.

Acceptance criteria used (issue #99 "Done when"): pure functions in `packages/agent-adapters`
covering FR-118-06 (`fixture-contains-claude-config`, every listed path at any depth, fail
closed), FR-118-07 (no bare file-tool allow rule, `Edit(/**)`,
`blockReadsOutsideWorkingDirectories`, no `--add-dir`, `disableSkillShellExecution`), FR-118-08
(`Skill` only for `skill-md`, `baseline-skill-name-differs`), FR-118-26 (`artifact-executes-code`,
`artifact-overrides-model`, candidate and baseline), FR-118-27 (`workspace-imports-outside`,
`workspace-scan-limit`, `WORKSPACE_SCAN_MAX_FILES`/`WORKSPACE_SCAN_MAX_BYTES`, linear-time test),
the env rules of FR-118-02/03, the flags hash of FR-118-04 equal for two workspaces; 100% unit
coverage including the unit-testable parts of AC-16, AC-23, AC-25, AC-26 and AC-27.

Non-goals: stream parsing, `skillActivation`, error normalisation and the engine's
execution-model check (Phase 3 step 2); process control and the fake `claude` (step 3);
readiness and detection `ready`/`missing` (step 4, issue #102, in flight — `detection.ts` is not
touched); the `benchmark` CLI (Phase 4); the `AgentRunRequest`/`AgentRunResult` contract
extensions of SPEC-203 §4.2 (needed by step 2/3, not by pure builders).

## Plan

Goal: a `packages/agent-adapters/src/claude-code/` module with pure builders (argv, flags hash,
env, version, install convention, skill name) and pre-spawn inspection (fixture/workspace
Claude-configuration check, import and link scan, artifact bundle inspection), each fail closed
and unit-tested to 100%.

Risks: the import scan is security-critical and must be linear in workspace size while treating
every `@` as a token (a run of `@` without whitespace makes naive suffix tokens quadratic); paths
must be canonicalised (`realpath`) and unknown existence fails closed; the install must not write
through a symbolic link a `setup` command planted (setup runs before installation); behaviours of
Claude Code that are only assumptions stay marked for the AC-22 live check.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Builders

- [ ] 1.1 argv per permission profile and artifact type, `Skill` rules, settings, normalised flags hash, version parser
- [ ] 1.2 env per auth mode (subscription strips credential variables, api-key isolates `HOME`/`CLAUDE_CONFIG_DIR`)
- [ ] 1.3 Install convention (§4.1) with symlink-safe writes, skill name resolution and `baseline-skill-name-differs`

### Phase 2: Inspection

- [ ] 2.1 Artifact bundle inspection (FR-118-26) for candidate and baseline
- [ ] 2.2 Workspace walk with named limits and the Claude-configuration check (FR-118-06)
- [ ] 2.3 Import and link scan (FR-118-27) with a linear-time test

### Phase 3: Verification and documentation

- [ ] 3.1 Quality gate, SPEC-118 §20 / SPEC-203 §13 status, lessons, run log
