---
title: Claude Code readiness — auth status, API key presence, detection ready/missing (SPEC-118 Phase 3 step 4)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: om-auto-fix-issue 102 (E06-S03-T04), feature route → om-auto-implement-spec → om-auto-create-pr
status: completed
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

PR: #107

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Readiness core

- [x] 1.1 Shared probe helpers (PATH lookup, env allowlist, empty temp cwd, named timeouts and output cap) — 13b80e2, a5b827f
- [x] 1.2 Claude Code version parser, minimum-version check and `claude auth status` parser — 13b80e2, a5b827f
- [x] 1.3 `checkClaudeCodeReadiness` per auth mode and `detect()` reporting `ready`/`missing` — 13b80e2

### Phase 2: Surfaces

- [x] 2.1 `directivebench doctor` shows readiness per auth mode — 065a74f
- [x] 2.2 Agent Connections page shows readiness; Playwright test with a fake `claude` — 1846543

### Phase 3: Verification and documentation

- [x] 3.1 Quality gate, real readiness output on this machine, SPEC-203/SPEC-118 status, lessons — 4148e9b, a5b827f, this commit

## Decisions

- **Readiness lives in `claude-code-readiness.ts` and `probe.ts`, not under `src/claude-code/`**,
  so this run does not touch the modules the parallel #99 creates. #99 also plans a version
  parser; whichever PR merges second keeps one (follow-up).
- **Subscription readiness runs `auth status` with an environment allowlist** (no `ANTHROPIC_*`,
  `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`) in an empty temp directory: observed on 2.1.302, a key in
  the environment makes `auth status` report `loggedIn: true` (`api_key`), and project settings
  of the caller's directory could define `apiKeyHelper`. This matches SPEC-203 §3.2 (real `HOME`,
  no `CLAUDE_CONFIG_DIR` override for the agent).
- **Ready only when `loggedIn: true` and exit 0**; everything else fails closed as
  `auth-missing`. `auth-expired` only for unparsed output containing the SPEC-203 §9 text
  "Login expired" — the real expired shape could not be observed. `authMethod` is shown but not
  enforced, because `auth status` loads user settings that a subscription run excludes
  (`--setting-sources project,local`), so a mismatch there would be a false refusal.
- **Detection reports both modes**; `auth` is `ready` when one mode is ready (SPEC-203 AC-2).
  `doctor` warns only when no mode is ready, since the agent is optional.
- **Probes are killed with SIGKILL** on timeout (`execFile` destroys the pipes, so a grandchild
  holding them cannot hang the caller — tested), and they never reject (temp-dir errors map to
  `failed`). Relative `PATH` entries are skipped.
- **Playwright puts a fake logged-in `claude` first on the server's PATH** and clears
  `ANTHROPIC_API_KEY`, so the Agent Connections row is deterministic and no real login is used.

## Work performed

1. Plan and draft PR #107 — 4eb6ec7.
2. `probe.ts`, `claude-code-readiness.ts`, `AgentModeReadiness`/`readiness` in the contract,
   detection hook; unit tests with a fake `claude` — 13b80e2.
3. `doctor` lines per auth mode — 065a74f.
4. Agent Connections readiness column and Playwright test — 1846543.
5. SPEC-203 §3.2/§4.2/§13 (+ evidence L2), SPEC-118 §20, SPEC-116 table, two lessons — 4148e9b.
6. Review round 1 fixes — a5b827f.

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`: pass at a5b827f, 100%
  coverage in every package (agent-adapters 75 tests, CLI 78).
- `pnpm build && pnpm verify:pack`: pass ("Packaging verification passed") at 1846543.
- `pnpm test:e2e`: 39 passed at 1846543, including "Claude Code readiness is shown per auth mode".
- Real, read-only, on this machine (`claude` 2.1.302, built CLI):
  - `doctor` without `ANTHROPIC_API_KEY`: `agent:claude-code:subscription ready: Logged in
    (claude.ai).`, `agent:claude-code:api-key not ready (auth-missing)`.
  - `doctor --json` with a dummy key: api-key `ready: ANTHROPIC_API_KEY is set.`; the key appears
    0 times in the output.
  - `doctor` with an empty `HOME`: both modes `warn … not ready (auth-missing)`.
  - `serve` + `/agents`: Claude Code row "ready — Subscription: ready — Logged in (claude.ai)";
    Codex and Cursor "unknown".
  - No `directivebench-probe-*` directory left in the temp directory.
- Not verified: an expired subscription login (none available); macOS (Keychain login under the
  reduced environment); Windows; that `auth status` makes no paid call.

## Problems and deviations

- `NodeJS.ProcessEnv` is augmented by Next.js with a required `NODE_ENV`, so the allowlisted env
  failed only the web typecheck; it is typed `Record<string, string>` and widened at `execFile`
  (lesson).
- A first version had a hard deadline timer beyond `execFile`'s timeout; the test showed
  `execFile` already destroys the pipes, so the timer was dead code and was removed.
- `claude auth status` creates its configuration directory when missing, so `doctor` and
  `/agents` can create `~/.claude` on a machine where `claude` never ran — documented in SPEC-203
  §13 as an accepted side effect.

## Lessons recorded

- [`claude auth status` describes the environment it runs in](../lessons/2026-10-22-claude-auth-status-reflects-its-environment.md)
- [Next.js makes `NODE_ENV` required in `ProcessEnv`](../lessons/2026-10-22-next-requires-node-env-in-child-env.md)

## Follow-ups

- E06-S04: call `checkClaudeCodeReadiness(mode)` in `benchmark run` before the job is created and
  exit 2 with the code (FR-118-35/39).
- Merge with #99: keep one Claude Code version parser and minimum constant.
- Confirm the expired-login output of `claude auth status` in the live check (E06-S04-T01) and
  update the `auth-expired` mapping.
