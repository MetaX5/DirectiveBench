---
title: Claude Code readiness — auth status, API key presence, detection ready/missing (SPEC-118 Phase 3 step 4)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: om-auto-fix-issue 102 (E06-S03-T04), feature route → om-auto-implement-spec → om-auto-create-pr
status: in-progress
branch: feat/issue-102-claude-code-readiness
specs: [SPEC-118, SPEC-203, SPEC-116]
---

# Run: Claude Code readiness and detection ready/missing (issue #102)

Source doc: .ai/specs/2026-10-22-benchmark-own-skills-s1.md

## Objective

Implement SPEC-118 §21 Phase 3 step 4 for issue #102 (task of story #96): before a run starts,
DirectiveBench can tell whether Claude Code can run at all — `claude` on `PATH`, version ≥ the
SPEC-203 §7 minimum (`version-unsupported` otherwise), in subscription mode `claude auth status`
reports a login (only `loggedIn` and `authMethod` are parsed, credential files are never read,
the raw output is never persisted or logged; `auth-missing`/`auth-expired`), and in api-key mode
a non-empty `ANTHROPIC_API_KEY` in the CLI environment (FR-118-02, FR-118-35). `detect()` for
Claude Code reports `ready`/`missing` instead of `unknown` (SPEC-203 §4.2, §13, AC-1, AC-2).

Acceptance criteria used: the "Done when" of issue #102; SPEC-203 AC-1 and AC-2.

Non-goals: the argv/env builders, version-gated flags and pre-spawn inspection (#99, in flight in
parallel); the stream parser (#100); process control (#101); wiring readiness into
`benchmark run` with exit code 2 (E06-S04); Codex and Cursor readiness.

## Plan

Goal: one readiness function per auth mode for Claude Code, used by detection (the Agent
Connections page and `directivebench doctor`), tested with a fake `claude` and no credentials.

Risks: the status probe must never run with a secret in its environment or in an untrusted
working directory (a project `.claude/settings.json` could define `apiKeyHelper`); the raw
output contains personal data (email, organisation) and must never leave the parser; the web
page and e2e test must stay deterministic on machines with and without a real `claude`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Readiness core

- [ ] 1.1 Shared probe helpers (PATH lookup, env allowlist, empty temp cwd, named timeouts and output cap)
- [ ] 1.2 Claude Code version parser, minimum-version check and `claude auth status` parser
- [ ] 1.3 `checkClaudeCodeReadiness` per auth mode and `detect()` reporting `ready`/`missing`

### Phase 2: Surfaces

- [ ] 2.1 `directivebench doctor` shows readiness per auth mode
- [ ] 2.2 Agent Connections page shows readiness; Playwright test with a fake `claude`

### Phase 3: Verification and documentation

- [ ] 3.1 Quality gate, real readiness output on this machine, SPEC-203/SPEC-118 status, lessons

## Decisions

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
