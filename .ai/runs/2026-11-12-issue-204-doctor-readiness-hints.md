---
title: Remediation hints for doctor's Claude Code readiness warnings (issue 204)
date: 2026-11-12
agent: Claude Code / claude-opus-5-5
trigger: maintainer-approved issue #204, run through om-auto-fix-issue
status: completed
branch: fix/issue-204-doctor-readiness-hints
specs: [SPEC-009, SPEC-203, SPEC-118]
---

# Run: Remediation hints for doctor's Claude Code readiness warnings

## Objective

`directivebench doctor` printed `agent:claude-code:<mode>` readiness warnings without the
remediation `hint` SPEC-009 §4 requires for every non-`ok` check. Acceptance criteria (issue #204):
every such warning has a `hint` in text and `--json` output; a regression test runs `doctor` with
a fake logged-out `claude` and asserts a hint per warning code; `cli.test.ts > doctor > warns with
a hint …` passes with a logged-out `claude` on PATH; 100% coverage; no secret in a hint.

## Plan

1. Triage on `origin/main` (c17d0e5): the readiness `add(...)` in `doctorCommand` passes no hint.
   No open PR references the issue.
2. Red first: extend `apps/cli/test/doctor.test.ts` (hints for `auth-missing` per mode, text form,
   `auth-expired`, `auth-mismatch`, `version-unsupported`; a unit test of the hint function over
   every `ClaudeReadinessCode` × mode, exhaustive at type level via `satisfies Record<…>`).
3. Add `agentReadinessHint` in `apps/cli/src/commands.ts` with a `Record<ClaudeReadinessCode, …>`
   table and a generic fallback; pass it as the fourth `add` argument.
4. SPEC-009 §12 implementation-status note; gate; real run from the build.

## Decisions

- The hint table lives in the CLI, not on `AgentModeReadiness`, as the issue scoped it (the probe
  and the adapter contract stay unchanged).
- The table is a `Record<ClaudeReadinessCode, …>`, so a new SPEC-203 §9 code fails the typecheck
  until it has a hint. A code the table does not cover (another agent, a future code) gets a
  generic hint, so no warning is ever left without one (fail closed).
- Each auth hint also names the other mode (API key mode ↔ subscription), since one ready mode is
  enough (SPEC-118 FR-118-35). Hints name `ANTHROPIC_API_KEY`, never its value.

## Work performed

- Red-first tests, then `agentReadinessHint` and its use in `doctorCommand`.
- SPEC-009 §12: implementation-status entry for issue #204. Commit 2dc57d7; PR #211.
- `om-auto-review-pr 211 --autofix`: approve-level (COMMENT on own PR), one minor (the
  `auth-missing` hint after a probe failure) and one nit (an unusable key).
- Codex adversarial review round 1: needs-attention, one medium finding, the same point:
  `auth-missing` also covers a login probe that timed out, failed or gave unreadable output, and an
  API key that is set but unusable. Fixed in d6cfa8a by rewording both `auth-missing` hints so they
  fit every case and adding a doctor-level test (unreadable probe, planted multi-line key). The
  readiness codes stay unchanged (the issue puts the probe out of scope).
- Codex round 2: needs-attention, one medium finding: the subscription hint still pointed only at
  login when the probe itself fails for a logged-in user. Fixed by a hint that covers both outcomes
  (check `claude auth status`; `/login` when it shows no subscription login; fix or update Claude
  Code when it fails or hangs) and a doctor test where the fake reports a login but exits 3.
- Codex round 3: needs-attention, one medium finding: a probe that fails before `claude` starts
  (no temporary directory) is not a Claude Code problem. Fixed by wording the second branch as
  "otherwise fix the cause named in the warning (for example a `claude` that fails, hangs or cannot
  be started)". No doctor-level test for that path: the version probe runs first through the same
  `runProbe`, so a persistent temporary-directory failure surfaces as `version-unsupported`, and
  only a transient one could reach `auth-missing` (not deterministic to construct).
- Codex round 4: needs-attention, one medium finding of the same kind for `version-unsupported`,
  which also covers a failed or unreadable `claude --version`. Fixed by a hint that checks
  `claude --version` first (update only when it is older than the minimum, otherwise fix the cause
  the warning names) and a doctor test with a `--version` that exits 1. CLI tests: 194.
- Codex round 5: needs-attention, one medium finding: the hint named bare `claude auth status`,
  while the probe runs `claude --setting-sources project,local auth status --json` in an empty
  directory (a user-level `apiKeyHelper` changes the bare command's answer). Fixed: the hint is
  built from `CLAUDE_EXECUTABLE` and `CLAUDE_AUTH_STATUS_ARGS`, and a unit test pins it to them.
  CLI tests: 195.
- Codex round 6: **approve**, no material findings.

## Verification

- Red first: before the fix, 18 tests of the new and updated `doctor.test.ts` cases failed
  (missing `hint`, `agentReadinessHint is not a function`); after it all 42 pass.
- `cli.test.ts > doctor > warns with a hint when the data directory does not exist yet` with its
  pinned PATH temporarily pointed at a fake logged-out `claude`: fails without the fix, passes
  with it (temporary edit reverted).
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: pass.
- `pnpm test`: pass, 7/7 tasks, 100% lines, branches, functions and statements in every package
  (CLI 192 tests, 195 after the Codex fixes; full gate including build and `verify:pack` re-run after each Codex fix).
- `pnpm build && pnpm verify:pack`: pass.
- Real run: `node apps/cli/dist/cli.js doctor` and `doctor --json` from the build with
  `PATH=<fake bin>:<node>:/usr/bin:/bin`, the fake `claude` 2.1.302 reporting
  `{"loggedIn":false}`: both readiness warnings print `→ <hint>` and carry `hint` in JSON; with
  the fake reporting 2.1.0 and a planted `ANTHROPIC_API_KEY`, both modes show the update hint and
  the key appears nowhere in the output. Re-run on the final build (694ae41) with a logged-out
  fake, an unreadable probe plus a too-short key, and a `claude` whose `--version` fails: each
  warning shows the final hint text, in text and `--json`.
- Not verified: a pre-launch probe failure reaching `auth-missing` (only a transient
  temporary-directory failure could; see Codex round 3).
- Not verified: `doctor` against a real logged-out or expired `claude` (no real `claude` was run;
  the expiry text is the §9 assumption the probe already uses); `binary-not-found` cannot reach
  `doctor` (readiness is only listed for an installed agent) and is covered by the unit test only.

## Problems and deviations

- CI `Unit tests (100% coverage)` failed on 2dc57d7 in `packages/runner`
  `hosted-repository.test.ts > versions only changed content on a rescan …` (5 s test timeout on
  the loaded Linux runner; untouched by this PR, passed locally and on macOS); the failed job was
  re-run.

## Lessons recorded

None: the PATH-pinning constraint was already recorded
([2026-11-10-doctor-tests-pin-path](../lessons/2026-11-10-doctor-tests-pin-path.md)).

## Follow-ups

- None required. The web Agent Connections page shows readiness `detail` only; whether it should
  show the same hints is a separate product question.
