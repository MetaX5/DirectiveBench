---
title: Run-time check of the skill name against the session's system/init (issue 275)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: maintainer request, issue 275 (follow-up of issue 257, PR 276)
status: completed
branch: feat/issue-275-runtime-reserved-name-check
specs: [SPEC-203, SPEC-118]
---

# Run: Run-time check of the skill name against the session's system/init

## Objective

After the spawn, compare the installed skill name with the session's `system/init` `skills` and
`slash_commands`, and end the agent run `infrastructure-error` with a named code on a collision
with a name Claude Code owns, without presenting the benchmark run as comparable. The static
plan-time list of issue 257 stays the first line. Blocking question: does `system/init` list a
colliding name once or twice? The maintainer allowed exactly one real `claude` session to answer
it.

## Plan

1. One live session: production argv (`buildClaudeArgv`, `buildClaudeEnv`, `runClaudeProcess`),
   a project skill named `doctor` in a throwaway workspace under `/var/tmp`, cheapest prompt.
2. Design from the evidence; stop if the only safe rule refuses every run.
3. Implement in parser, normaliser and adapter; stop code in the engine; red-first tests with the
   recording and the fake `claude`; specs; gate; real built CLI; Codex review; draft PR.

## Decisions

- **Evidence (live check, `claude` 2.1.325, subscription, 2026-11-19):** a temporary vitest file
  (deleted afterwards, `ISSUE275_LIVE_ONCE=1`) built the production argv for a placeholder skill
  and renamed its `Skill(...)` rules to `doctor` (the argv builder refuses `doctor` since issue
  257), plus `--model haiku` and `--effort low`; prompt "Reply with the single word OK.". One
  session, exit 0, result `OK`, `total_cost_usd` 0.00058 (the CLI's estimate). `system/init`:
  `skills` `["doctor", "design", "plugin-authoring"]`; `slash_commands` with `doctor` once, first
  (the project-skill position; in 2.1.302 the CLI's `doctor` sat between bundled skills);
  `terminal_slash_commands` `["color", "focus", "reload-plugins"]` (2.1.302 had `doctor` there
  too). So a colliding name is listed **once**, like any installed skill. New built-in slash
  command against the static 2.1.302 list: `ultrareview`.
- **Design:** in a run with the skill installed the CLI's entry cannot be told from the installed
  one, and refusing a single entry would refuse every skill run. A run that installed nothing
  (the `none` baseline: `installedPaths` empty) must not list the name at all, since fixtures
  carry no Claude Code configuration and user-level skills are not loaded; any entry there is the
  CLI's own. A run with the skill installed still fails closed on a name listed more than once
  (cheap, never the normal state). This is not a product choice left open: it refuses nothing
  that is not a collision, and the remaining gap (A/B runs have no skill-less variant) is a
  documented residual, so the run continued to implementation.
- **Code:** reuse `skill-name-reserved`: same condition (Claude Code lists the name itself), same
  remedy (rename); the message says the session start showed it. Added to the engine's
  `STOP_CODES` (FR-118-15): every further agent run would measure an unknown skill; the benchmark
  run ends with status `error`, never comparable. Odd repetitions run the baseline first, so the
  first agent run of a `none` run catches it.
- **Precedence:** the collision wins over the stream's own outcome (completed or agent error); a
  process-layer end (timeout, cancellation, output limit) still wins, as for every outcome.
- No ADR: the rule extends the issue-257 decision inside SPEC-203 §4.1 / SPEC-118 FR-118-08.

## Work performed

1. Live check and the redacted recording
   `packages/agent-adapters/test/fixtures/claude-code/2.1.325/live-subscription-reserved-doctor.ndjson`
   (`system/init` and `result` only; workspace and socket paths replaced like the 2.1.302
   recordings; the assistant message and the plan's rate-limit event dropped).
2. `ClaudeInitFacts.skillNameEntries` (stream parser), `claudeSkillNameCollision` and
   `ClaudeRunConditions.skillInstalled` (normaliser), `skillInstalled` from `installedPaths` in
   `ClaudeCodeAdapter.run`, `skill-name-reserved` in `STOP_CODES`.
3. Tests: `runtime-reserved-name.test.ts` (recording), `adapter.test.ts`, engine
   `claude-code-adapter.test.ts` and `stop-codes.test.ts`. The fakes used to replay the same
   session start for both variants, so a `none` baseline listed the skill; the adapter harness now
   installs its default skill, and the engine, CLI and e2e fakes list `pdf` only when the workspace
   has it installed, as the CLI does.
4. SPEC-203 §4.1 (rule, residual), §9 (row), §11 (live check), §13 (status); SPEC-118 FR-118-08,
   FR-118-15, §13 (row), §20 (status).

## Verification

- Red first (new tests on the old source, `git stash` of `src`): 6 of 6 in
  `runtime-reserved-name.test.ts` and the new `adapter.test.ts` case failed (`skillNameEntries`
  undefined, `status: 'completed'`); engine: `stop-codes.test.ts` and the new end-to-end case
  failed (stopped with another code than `skill-name-reserved`).
- `pnpm lint`: pass. `pnpm typecheck`: pass. `pnpm format:check`: pass after Codex round 1 found
  two unformatted files. `pnpm exec turbo run test --force`: pass, 100%
  coverage in every package (agent-adapters 393 + 2 skipped, benchmark-engine 520, cli 210, core
  353, database 385, runner 313, web 647). The first `pnpm test` replayed cached CLI results and
  hid 9 CLI failures (see the lesson).
- `pnpm build`: pass. `pnpm verify:pack`: pass ("Packaging verification passed").
- Real CLI: `apps/cli/dist/cli.js benchmark run <suite> --artifact ultrareview --yes` with a data
  directory under `/var/tmp`, the skill seeded with `importArtifactVersion` (temporary vitest file,
  deleted) and a fake `claude` 2.1.325 on `PATH` replaying the recording: `Result: error`,
  `Error: Stopped after case example, baseline repetition 1 (skill-name-reserved): Claude Code
  lists the skill name "ultrareview" itself: ...`, exit 6, one `claude` start, the stored agent
  run `baseline` `infrastructure-error`, benchmark run status `error`.
- Not verified: `pnpm test:e2e` locally (the Playwright Chromium build is not installed; the
  `real-capture` spec's fake was changed and runs in CI); a full benchmark run with a real
  `claude`; which `doctor` a session uses on a collision; a duplicate entry (no version was seen
  to produce one).

## Problems and deviations

- The turbo cache replayed dependent packages' test results after a change in `packages/*`.
- The live session used `--model haiku` and `--effort low` on top of the production argv to keep
  it cheap; skill listing does not depend on the model.

## Review

- Codex adversarial review round 1 (`afbe6dc`..`b10e70e`): approve, no material findings;
  `pnpm format:check` failed on `normalize.ts` and `adapter.test.ts` (fixed with Prettier).

## Lessons recorded

- [`.ai/lessons/2026-11-19-turbo-replays-dependent-package-tests.md`](../lessons/2026-11-19-turbo-replays-dependent-package-tests.md)

## Follow-ups

- Refresh the static list for 2.1.325 (`ultrareview` is new) together with its documented version.
- A/B runs have no skill-less variant, so the run-time check covers them only for duplicate
  entries.
- `turbo.json`: make `test` depend on its workspace dependencies so dependents are not replayed.
