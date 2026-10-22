---
title: Claude Code process control, setup process-group kill and workspace pin wiring (issue #101)
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 101 (E06-S03-T03, SPEC-118 Phase 3 step 3)
status: completed
branch: feat/issue-101-process-control
specs: [SPEC-118, SPEC-203, SPEC-107, SPEC-110]
---

# Run: Claude Code process control (issue #101)

## Objective

Spawn `claude` with the argv/env of the merged builders (argv only, env allowlist, prompt on
stdin, cwd = pinned workspace) in its own process group, with a named timeout, cancellation
(SIGTERM, then SIGKILL after a named grace), output caps and the raw stdout lines exposed for the
stream parser of #100 (no parsing here); call `inspectWorkspace` right before each spawn and map
findings to `infrastructure-error` (FR-118-06/27, FR-118-15 codes). Plus the two requirements of
the PR #108 reviews (SPEC-118 §12): the orchestrator pins the workspace before `setup` and passes
the pin to installation and inspection, and every `setup` command's process group is killed when
the command ends. AC-10 (process part): no `claude` process remains 10 s after cancellation with a
fake CLI ignoring SIGINT/SIGTERM.

## Plan

1. `packages/agent-adapters/src/process-group.ts`: signal a process group, kill it and wait until
   it is gone (named poll interval and bound). Shared by `runCommand` and the Claude process.
2. `runCommand` (benchmark-engine): on the leader's exit, SIGKILL the group and wait; report
   processes that did not stop; regression test with a `setup` that leaves a background child.
3. Move `WorkspacePin` to the adapter contract level; `installArtifact(pin, …)` and
   `AgentRunRequest.workspace` carry the pin, plus `installedPaths` and a run-local `scratchDir`.
   Orchestrator: pin after the fixture copy and before `setup`, re-check the pin after `setup`.
4. `claude-code/process.ts` (`runClaudeProcess`) and `claude-code/run.ts` (`runClaudeCode`:
   abort check → pre-spawn inspection → spawn). Fake `claude` in tests.
5. Tests, gate under `taskset -c 0,1`, spec status, lesson, PR, review loop, CI.

## Decisions

- No `ClaudeCodeAdapter` class yet: its `run` needs the stream parser (#100). Process control is
  exposed as `runClaudeCode` → `{ ended, findings, process }`: `ended` is set for every end the
  process layer decides (refused, cancelled, timeout, spawn failure, stray processes, output
  limit); otherwise `process.lines` (raw, unredacted) go to the parser. Composition is a follow-up.
- Contract change (breaking for adapters, all in-repo): `installArtifact(pin, …)`,
  `AgentRunRequest.workspace` (pin) replaces `workspaceDir`, plus `installedPaths`, `scratchDir`
  and the status `infrastructure-error`. `WorkspacePin` moved from `claude-code/` to the package
  root, since the contract uses it.
- Escalation is SIGTERM → SIGKILL (5 s), without the SIGINT step drawn in SPEC-203 §5 (noted there).
- New codes `output-limit` (`agent-error`) and `stray-processes` (`infrastructure-error`) added to
  SPEC-203 §9.
- `installClaudeArtifact` re-runs the FR-118-26 bundle inspection (second line), so a version with
  frontmatter `hooks` is never installed and `claude` never sees it.
- Engine waits `AGENT_STOP_GRACE_MS` = 10 s (was an unnamed 5 s) beyond the timeout, longer than
  the adapter's own stop sequence.
- Review round 1 (independent `om-code-review`, changes requested) fixed in a second commit: a
  process outside the group that holds the output pipes no longer blocks `runCommand` forever (a
  named drain, `PROCESS_OUTPUT_DRAIN_MS`, reported as `strayProcesses` in both process layers);
  no signal is sent after the leader exited; `stray-processes` takes precedence in
  `claudeProcessEnd`; command assertions fail on stray processes; a throwing `spawn` records only
  the error code. Not changed: the install inspects with role `candidate` (the role is not used in
  the message). Round 2 (`eb0dc38`): approve; nit n3 (Windows: any background child holding the
  output counts as stray) documented in `78157ab`, which also merges `main` (PR #105) and keeps
  the stray check in the restructured command assertion; gate re-run on the merged tree: pass.

- Codex adversarial review (needs-attention, two HIGH, both valid), fixed in a third round:
  (1) after SIGKILL nothing bounded the wait for `exit`/`close`, so a leader whose signals were
  refused (`EPERM`) kept `runClaudeProcess` and `runCommand` pending forever — now
  `PROCESS_KILL_CONFIRM_MS` gives it up (pipes closed, child unref'd, `strayProcesses`); tests
  inject `EPERM` and fail without the bound (verified by disabling it). (2) `infrastructure-error`
  did not stop the benchmark (FR-118-15): the integration test even let the candidate run after
  the baseline's refusal. Now `AgentRunResult.errorCode` → `AgentRunRecord.errorCode` →
  `assertNotStopped` with `STOP_CODES` in `benchmark-engine/src/stop.ts` throws
  `BenchmarkStoppedError`; names match PR #111's draft so #100 can import them instead of its own
  copy.

- Codex round 2 (round-1 fixes confirmed; one HIGH, valid): the post-SIGKILL abandonment path
  closed stdout/stderr and unref'd the child but left `child.stdin` with an unread prompt queued
  and referenced, so the CLI process could stay alive indefinitely. Now stdin is destroyed too;
  the EPERM regression test sends a 4 MiB prompt the fake never reads and checks that no
  referenced pipe handle remains (fails without the fix: 4 pipes vs 3). `runCommand` spawns with
  stdin `ignore`, so it has no such handle.

## Work performed

1. `process-group.ts` (signal, kill-and-wait); `runCommand` kills the group on exit.
2. Contract + orchestrator: pin before `setup`, re-check after, stray-process failure, scratch dir.
3. `claude-code/process.ts`, `claude-code/run.ts`; install re-inspection.
4. Fake `claude` (`test/claude-code/fake-claude.ts`) and tests; engine integration test with the
   real install/inspection/process functions and a fake `claude`.
5. SPEC-118 §12/§20, SPEC-203 §9/§13, lesson.

## Verification

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: pass.
- `taskset -c 0,1 pnpm test --force`: all packages pass at 100% coverage (agent-adapters 214,
  benchmark-engine 124, runner 229, core 266, database 131, web 157, cli 78).
- Process/engine timing tests also pass on two cores under `yes > /dev/null` × 6.
- Regression proof: with the exit kill disabled in `runCommand`, the three new setup tests fail
  (background child alive; command blocked until timeout; late `.claude` write appears).
- `pnpm build`, `pnpm verify:pack`: pass. `directivebench demo` on a temp data dir: improved,
  as before.
- Not verified: Windows and macOS process handling, the real `claude` CLI, the `permission-denied`
  classification (parser, #100), the CLI Ctrl-C → exit 130 part of AC-10 (Phase 4).

## Problems and deviations

- Next.js `ProcessEnv` typing again (known lesson): `spawn` env widened at the call.
- A failed spawn emits `close` with the negative errno as code; reported as `exitCode: null`.

## Lessons recorded

- [2026-10-22-kill-the-process-group-when-the-leader-exits.md](../lessons/2026-10-22-kill-the-process-group-when-the-leader-exits.md)

## Follow-ups

- Compose `ClaudeCodeAdapter` (install + `runClaudeCode` + parser of #100) and register it for
  `benchmark run` only (FR-118-05, Phase 4).
- CI flakes outside this change, both seen on `10448cf` (run 39788206397, attempts 1 and 2) and
  passing locally on 2 cores: `packages/runner/test/hosted-git.test.ts` "fails the blob fetch…"
  (a 200 ms fake-git timeout read as `timeout` instead of `git-failed`) and
  `apps/web/test/markdown.test.ts` "parses pathological input in linear time" (ratio bound).
- The hosted-git flake failed CI twice on this branch (also on `a21ad5e`, run 39789383614 attempt
  2), so its test now uses the 200 ms timeouts only for the cases that expect a timeout (test-only
  change in `packages/runner/test/hosted-git.test.ts`); the web ratio flake is left as is.
