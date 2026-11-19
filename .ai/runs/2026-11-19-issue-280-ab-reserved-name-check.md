---
title: Detect a CLI-owned skill name at run time in A/B runs (issue 280)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #280, taken with the maintainer's approval; phase A (options and recommendation) before a product decision
status: completed
branch: feat/issue-280-ab-reserved-name-check
specs: [SPEC-203, SPEC-118]
---

# Run: Detect a CLI-owned skill name at run time in A/B runs

## Objective

Issue #280: an A/B run (candidate version vs baseline version of the same skill) has no agent run
without the skill, so a skill name that a newer `claude` lists itself and the static list
`CLAUDE_RESERVED_SKILL_NAMES` misses goes undetected. Done when an A/B run of a skill whose name a
newer `claude` lists itself is refused or marked not comparable, with a regression test (fake
`claude` and recordings only).

The run has two phases. **Phase A** (this entry): restate the gap, evaluate the options, recommend
one, stop for a maintainer decision. **Phase B**: implement the decision (not started).

## The gap, restated

- Plan-time line: `assertClaudeSkillNameNotReserved` refuses names in the static list, documented
  as observed up to `claude` 2.1.325 (`CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION`). It only knows
  names someone recorded.
- Run-time line (#277, `claudeSkillNameCollision` in `packages/agent-adapters/src/claude-code/normalize.ts`):
  - an agent run that installed nothing (`skillInstalled === false`, the baseline of a `none` run)
    fails with `skill-name-reserved` when `system/init` lists the name at all;
  - an agent run that installed the skill fails only when `skills` or `slash_commands` lists the
    name **more than once**.
- Evidence (recording `packages/agent-adapters/test/fixtures/claude-code/2.1.325/live-subscription-reserved-doctor.ndjson`,
  project skill named `doctor`, which 2.1.302 also lists as the CLI's own): `skills` =
  `[doctor, design, plugin-authoring]` and `slash_commands` holds `doctor` once. The CLI's entry
  and the installed one merge into one entry, so with the skill installed they cannot be told apart.
- In an A/B run both variants install a skill (candidate and baseline version, same resolved name,
  FR-118-08 `baseline-skill-name-differs`), so every agent run takes the "installed" branch. The
  duplicate-entry rule is the only run-time signal left, and no observed version produces a
  duplicate. Result: in A/B a collision is caught only when the name is already in the static list.
- Concrete miss: 2.1.325 added the built-in `/ultrareview`. Before #285 an A/B run of a skill named
  `ultrareview` on 2.1.325 would have passed both lines. The same happens for the next built-in a
  newer `claude` adds until someone refreshes the list.
- Why it matters in A/B too: if the CLI's own skill or command wins, both variants measure the
  CLI's thing, so the comparison reports "no difference" between two versions it never ran.

## Options evaluated

Cost figures for a one-turn session come from the 2.1.325 recording above (the issue 275 live
check: `--model haiku --effort low`, prompt "Reply with the single word OK."): 1 turn, 990 ms
wall time (655 ms API), `total_cost_usd` 0.00058, about 7.1k input tokens mostly cache reads. A
larger model costs proportionally more (estimate, not measured).

### Option 1: skill-less probe session before the first repetition

The orchestrator, for an A/B run of a `skill-md` artifact on the `claude-code` adapter, runs one
extra session before any variant: same argv, environment, auth mode and isolation as the agent
runs, in an empty scratch workspace with nothing installed, a fixed minimal prompt. Its
`system/init` is checked with the existing `skillInstalled === false` branch: any entry of the
name is the CLI's own, so the benchmark run stops with `skill-name-reserved` before the first
candidate session.

- False negatives: only a name that appears between the probe and the agent runs (server-side
  flag flip within one run) or a name that is reachable but not listed in `system/init` (the
  `/checkup` alias case, already covered by the static list). Catches names gated by plan, auth
  mode or feature flags on this machine, which the static list cannot.
- False positives: none expected; the probe has the same settings as the runs, so a listed name
  is listed for the runs too. User-level skills are not loaded (`--setting-sources project,local`,
  FR-118-08) and the scratch workspace has no configuration (FR-118-06).
- Cost: one short session per A/B benchmark run (not per case or repetition), about 1 s and
  under a cent on haiku; on a subscription it uses a sliver of the plan quota. A benchmark run has
  cases x repetitions x 2 sessions, so the probe is a small fraction.
- Label: not an agent run of either variant, never scored, never in RED/GREEN or A/B results.
  Stored on the benchmark run as its own record (status, duration, cost, `claude` version), its
  cost counted in the run total and shown as "Reserved-name check: 1 extra session (not scored)".
- Probe fails (auth, rate limit, timeout, no `system/init`): fail closed. The benchmark run ends
  `error` with a stop code (proposed `reserved-name-check-failed`, or the probe's own auth or
  rate-limit code) before any variant starts, so nothing else is spent. Side benefit: an auth
  problem surfaces before the first real session.
- Mock agent: not applicable. The mock lists no CLI names; the probe is a `claude-code` adapter
  capability the orchestrator calls only when the adapter offers it, so mock runs are unchanged
  (and remain labelled mock).
- ADR: yes. It adds a session and cost to every A/B run (the issue asks for an ADR in that case).
- Spec impact: SPEC-203 §4.1 (run-time check: A/B residual replaced by the probe rule), SPEC-118
  FR-118-08 (the A/B sentence) and FR-118-15 (new stop code if a dedicated one is chosen), cost
  accounting where run totals are defined.
- Tests: the existing fake `claude` (`packages/agent-adapters/test/claude-code/fake-claude.ts`)
  replays a `system/init` without a skill that lists the name (derived from the 2.1.325 recording,
  name `doctor` or a synthetic `ultrareview` case) -> stop with `skill-name-reserved`, no variant
  run; one that does not list it -> the A/B run proceeds; probe failure modes (no init, auth error,
  timeout, non-zero exit) -> fail closed; `none` runs and mock runs start no probe; cost and
  record of the probe in the run. Engine side in `packages/benchmark-engine/test` with a fake
  adapter.

Sub-variants:

- **1a, probe every A/B `skill-md` run** (recommended): one code path, no version parsing, also
  catches plan- or flag-dependent names on documented versions.
- **1b, probe only when `claude --version` is newer than `CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION`
  or unknown**: no extra session on documented versions; needs a version compare, and `claude`
  releases often (2.1.302 on 2026-10-26, 2.1.325 on 2026-11-19), so in practice most runs would
  still probe.
- **1c, init-only probe** (terminate the process right after `system/init`, or use a prompt that
  needs no model turn): could make the probe free, but whether a request is already sent and
  billed at that point is not known. Assumption, requires a consented live check; not proposed now.

### Option 2: compare against a recorded skill-less `system/init` of the same `claude` version

- Source in a user's local install without an extra session: only the baseline agent runs of
  earlier `none` runs of the same `claude` version on this machine. Today nothing usable is
  persisted: the metadata keeps `adapterVersion` and `installedSkillName`, and the trace keeps only
  counts ("N tools, N skills"). This needs a new persisted name set (migration, repository
  function, write on every `none` baseline, read before A/B), keyed at least by `claude` version
  and auth mode.
- Cold start: a user who only runs A/B, or the first A/B run after a `claude` update, has no
  record. The fallback is option 3 (refuse) or option 1 (probe), so option 2 never stands alone.
- False negatives: names gated by plan or server-side flags that changed since the record; a
  record taken under another auth mode or isolation. False positives: low.
- A recorded `system/init` shipped in the repository is the static list again (no gain for newer
  versions).
- Cost: no extra session when a record exists. Complexity: highest (database, two packages, cache
  invalidation). ADR: probably (new persisted data, comparability across runs).

### Option 3: refuse (or mark not comparable) A/B runs on a `claude` newer than the documented version

- Zero cost, small change (version compare against `CLAUDE_RESERVED_SKILL_NAMES_CLI_VERSION`
  before any job; unknown version fails closed).
- False positives: nearly every A/B run once the user's `claude` updates, until a DirectiveBench
  release refreshes the list; with the release cadence above that is most of the time. Refusing
  makes A/B unusable; "not comparable" spends the whole run's cost and then discards the verdict.
- False negatives: plan- or flag-dependent names on a documented version.
- Spec impact small (SPEC-203 §4.1, SPEC-118 FR-118-08), no ADR. Tests: version strings only.
- Useful only as the fallback of option 2, or as a user-overridable warning, not as the fix.

### Option 4: unknown built-ins in the candidate session (`slash_commands` minus `skills` minus the static list)

- Idea: any entry of `slash_commands` that is neither in `skills` nor in the static list is a new
  built-in, visible even with a skill installed.
- Checked against the 2.1.325 recording: `slash_commands` minus `skills` is the 2.1.302 built-ins
  plus `ultrareview` (and `__remote-workflow`, not a valid skill name). So against the 2.1.302-era
  list the heuristic does flag `ultrareview` as new, **but only because the installed skill was
  `doctor`**. If the installed skill were named `ultrareview`, its single merged entry would sit in
  `skills` and `slash_commands` alike (the same merge as `doctor`), so it drops out of
  `slash_commands` minus `skills`, and every other name is known: no signal. The heuristic misses
  exactly the colliding name, which is the case the issue is about.
- What it can do: tell that the static list is stale for this `claude` version (some other new
  name exists). As a warning it is cheap (zero cost, no ADR), but a version that adds exactly one
  new name, the colliding one, gives nothing, so it does not satisfy "Done when".
- False positives: names listed by plugins or legacy commands outside the workspace, if any are
  loaded (user-level skills are not; plugin names with `:` can never collide with a valid skill
  name).

### Option 5 (found while reading): provenance of an invoked skill

- When the skill is invoked, the stream carries the loaded skill body with "Base directory for this
  skill: <path>" (2.1.302 recordings `live-subscription-confine.ndjson` and `slash-expanded.ndjson`).
  A path outside the workspace's `.claude/skills/<dir>` would show that the CLI's own skill ran.
- Zero cost, works in A/B, but only for runs that invoked the skill via the `Skill` tool or an
  observed expansion; nothing for uninvoked runs, inferred `/<name>` expansions or built-in
  commands that are not skills. It relies on undocumented message text, and no recording shows a
  colliding name being invoked, so which entry wins is still unverified.
- Complementary hardening at most; a candidate follow-up.

### Summary table

| Option | Catches the `ultrareview` A/B case | False positives | Cost per A/B run | UX | Spec / ADR | Test strategy |
| --- | --- | --- | --- | --- | --- | --- |
| 1a probe every A/B run | Yes, also plan- or flag-gated names | None expected | 1 short session (about 1 s, under a cent on haiku) | Transparent; stops before spending on variants; labelled not scored | SPEC-203 §4.1, SPEC-118 FR-118-08/15, ADR | Fake `claude` replays skill-less inits; engine with fake adapter |
| 1b probe only on newer versions | Yes on newer versions; misses gated names on documented ones | None expected | 0 or 1 session | Same as 1a | Same as 1a, plus version compare | Same plus version strings |
| 2 recorded skill-less init | Only when a `none` run of that version exists | Low (stale records) | 0 with a record; fallback otherwise | Depends on history; surprising cold starts | Migration, SPEC-203, SPEC-118, likely ADR | Database fixtures plus fake `claude` |
| 3 refuse or mark on newer versions | Yes, by refusing everything newer | Very high (most A/B runs) | 0 | Poor: A/B blocked until a release | SPEC-203 §4.1, SPEC-118 FR-118-08 | Version strings |
| 4 unknown built-ins | No (the colliding entry merges away) | Some | 0 | Warning only | Small | Recording-derived inits |
| 5 invocation provenance | Only if invoked and the CLI's skill won | Wording changes | 0 | Per-run error | SPEC-203, SPEC-118 FR-118-09 | Recording-derived streams |

## Recommendation (awaiting maintainer decision)

**Option 1a: one skill-less probe session before the first repetition of every A/B run of a
`skill-md` artifact with the `claude-code` adapter**, checked with the existing
`skillInstalled === false` rule, failing closed, recorded and costed on the benchmark run as "not
scored", with an ADR. Reasons: it is the only option that detects the colliding name itself on any
`claude` version, including names gated by plan or flags; it reuses the rule #277 already ships for
`none` baselines; its cost is one tiny session against cases x repetitions x 2 real sessions; it
needs no database change and no version parsing; and it stops the run before any variant spends
money. Option 3 blocks A/B for most users, option 2 still needs 1 or 3 for its cold start, and
options 4 and 5 miss the case the issue names.

Decisions needed from the maintainer:

1. Approve option 1 (and 1a vs 1b).
2. Stop code for a failed probe: a dedicated `reserved-name-check-failed`, or reuse the probe's own
   classification (auth, rate limit, timeout) as stop codes.
3. Probe argv: identical to the runs (recommended, same listing) or forced to the cheapest model
   (cheaper, but a model-dependent listing could differ).

## Maintainer decisions (2026-11-19, relayed, also on the issue)

1. Option 1a: a session without the skill before the first repetition of every A/B run of a
   `skill-md` artifact on `claude-code`; a listed name refuses with `skill-name-reserved` before
   any variant. No check for the mock agent (only when the adapter offers it).
2. A failed check ends the benchmark run `error` with the check's own stop code; the message names
   the reserved-name check.
3. Same argv, model and environment as the variants.
4. ADR (Proposed) and SPEC-203 §4.1, SPEC-118 FR-118-08/15 before the code.
5. Visible display only after approval of screenshots: backend now, UI proposal, then stop.
6. Option 5 filed as a follow-up issue (#288).

## Plan

1. ADR-0015 and spec updates (done before code).
2. Red-first engine tests with a scripted adapter (`reserved-name-check.test.ts`) and end-to-end
   tests with the real `ClaudeCodeAdapter` and a fake `claude` replaying the 2.1.325 recording.
3. Contract: optional `AgentAdapter.needsReservedNameCheck(artifact)`; Claude Code: `skill-md`.
4. Engine: `runReservedNameCheck` before the first repetition (empty pinned workspace
   `<workRoot>/reserved-name-check/`, `installedPaths: []`, fixed prompt, variants' request),
   fail closed, `onReservedNameCheck` callback.
5. Storage: `setBenchmarkRunEnvironment` (database) and the runner stores
   `environment.reservedNameCheck` (no migration).
6. Gate, built CLI proof, UI proposal screenshots, stop for approval.

## Decisions

- **Fallback stop code `reserved-name-check-failed`** for a failed check without a code of its
  own (a timeout, an adapter exception without a code, a completed session that reported no
  `system/init`). The maintainer asked for the check's own stop code; these failures have none.
- **Proof that the session start was seen:** a completed check must report
  `metadata.executionModel`; otherwise it fails closed (documented on the contract method).
- **Order:** the check runs before any variant workspace is prepared. A refusal of the artifact
  versions themselves (bundle inspection) now stops the run through the check, before `claude`
  starts, instead of refusing each agent run; a refusal of a variant's own workspace (fixture or
  `setup` configuration, imports of an installed file) comes after the check session. Recorded in
  SPEC-203 §4.1 and ADR-0015 (drawbacks); the plan-time refusals keep such suites from the runner.
- **Storage** in `benchmark_runs.environment.reservedNameCheck` (status, code, error, duration,
  usage, `claude` version, session model), written when the check ends, also when it stops the run.

## Work performed

1. Read issue #280, PRs #276, #277 and #285 context in code and specs, SPEC-203 §4.1, SPEC-118
   FR-118-08/09/15, the ADR index, the orchestrator and the Claude Code adapter.
2. Inspected the `system/init` of the recordings of 2.1.302 and 2.1.325 (option 4 check, cost
   evidence).
3. Created the worktree `.ai/tmp/issue-280-wt` on `feat/issue-280-ab-reserved-name-check` from
   `origin/main` and this run log (commit 2649bdc).
4. Phase B: ADR-0015, SPEC-203 §4.1 and SPEC-118 FR-118-08/15 (commit `docs(specs)`).
5. Red-first tests, then the contract method, the Claude Code adapter method, the engine check,
   the database function and the runner wiring (commit `feat(benchmark-engine)`). Existing A/B
   end-to-end tests updated where the check now runs first (bundle refusals stop through the check;
   fixture refusals start only the check session; stream indices shifted by one).
6. UI proposal (not committed): a temporary Storybook story of the run page's "Environment and
   versions" card, screenshots in `.ai/tmp/issue-280-shots/` (both themes, 1280 and 320 px, no
   horizontal overflow), and the proposed CLI text in `cli-output-proposal.txt`. The story file was
   removed from the worktree (a copy is in the shots folder).
7. Follow-up issue #288 (option 5, base directory of an invoked skill).
8. Maintainer approval of the display and of the three decisions (relayed 2026-11-19). Merged
   `origin/main` (2154dba, #287; one conflict in `adapter.test.ts`, the new `startsTheFake`
   timeout argument, resolved by keeping both).
9. CLI and web display (commit `feat(cli,web)`): plan line and session count, summary line,
   tokens including the check, `--json` `reservedNameCheck`; the run page fact in "Environment and
   versions"; a kept Storybook story (`Patterns/RED-GREEN result`, `ReservedNameCheck`) with
   pattern rule 7; Playwright `e2e/reserved-name-check.spec.ts`.
10. Codex round 1 (needs-attention, high): a completed check passed although its `system/init`
    lacked `skills` or `slash_commands`. Fixed red first (commit `fix(benchmark-engine)`): the
    adapter reports `nameListsReported`, the check fails closed without it, and the stored record
    carries the engine's `passed` decision, which the CLI and web read. Also ran Prettier on four
    files `format:check` flagged.
11. Codex round 2: no material findings (it could not run the gate in its read-only sandbox; the
    gate below was run here).
12. Browser QA agent (Playwright fallback, `agent-browser` not installed) on the built app with
    seeded runs on port 4402: no findings (texts, contrast 6.01 to 19.8:1, no horizontal scroll at
    320, keyboard order, console clean, not-found page).
13. Lesson evidence: the `pkill -f` pitfall recurred; added to
    `.ai/lessons/2026-10-14-testing-processes-and-http.md`.

## Verification

Phase A: analysis only. Phase B, backend first:

| Command | Result |
| --- | --- |
| red first: `vitest run test/reserved-name-check.test.ts` before the code | 9 failed, 2 passed (missing exports) |
| red first: `claude-code-adapter.test.ts -t "issue 280"` before the adapter method | 2 failed |
| red first: database `runs.test.ts -t "issue 280"` | failed (`setBenchmarkRunEnvironment is not a function`) |
| red first: runner `runner-acquired.test.ts -t "issue 280"` | failed (environment not stored) |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass (7 tasks) |
| `pnpm test` (coverage 100%) | pass after removing one unreachable branch |
| `pnpm exec turbo run test --force` | 7/7 tasks; core 353, web 655, agent-adapters 399 (+2 skipped), cli 211, runner 314, database 387, benchmark-engine 540 |
| `pnpm build` | pass |
| `pnpm verify:pack` | pass ("Packaging verification passed") |

Built CLI proof (`apps/cli/dist/cli.js`, data directory under `/var/tmp`, two versions of a skill
`newer-built-in` seeded with `importArtifactVersion` from a temporary test file, deleted; a fake
`claude` 2.1.325 on `PATH` replaying the 2.1.325 recording):

- CLI-owned name (`/ultrareview` renamed to `newer-built-in`): `benchmark run --baseline v1 --yes`
  printed `Result: error`, `Error: Stopped by the reserved-name check before any agent run
  (skill-name-reserved): Claude Code lists the skill name "newer-built-in" itself ...`, exit 6,
  one `claude` start in `<workRoot>/reserved-name-check/workspace`, no agent run stored, run
  `environment.reservedNameCheck.errorCode = skill-name-reserved`.
- Name not listed without the skill: `Result: passed`, exit 0, three starts (check, baseline,
  candidate), `environment.reservedNameCheck.status = completed`.

Phase B, after the display and the Codex fix (final code):

| Command | Result |
| --- | --- |
| red first: CLI `benchmark-report.test.ts` before the display | 4 failed |
| red first: web `run-detail.test.ts` before `reservedNameCheckText` | 6 failed |
| red first: Codex fix, adapter `normalize`/`stream-parser` tests | 3 failed |
| red first: Codex fix, engine `reserved-name-check` and `claude-code-adapter` tests | 4 failed |
| `pnpm lint`, `pnpm typecheck`, `pnpm format:check` | pass |
| `pnpm test` (coverage 100%) | pass |
| `pnpm exec turbo run test --force` | 7/7 tasks; core 353, agent-adapters 400 (+2 skipped), web 661, cli 216, runner 314, database 387, benchmark-engine 542 |
| `pnpm build`, `pnpm verify:pack` | pass ("Packaging verification passed") |
| `pnpm test:storybook` | 68 files, 344 tests pass |
| `pnpm test:e2e` (port 4402) | 208 passed (6.0 min), including `reserved-name-check.spec.ts` (3) |

Built CLI with the final code (same fake `claude` set-up, data under `/var/tmp`, removed):

- CLI-owned name: the plan shows `Reserved-name check: 1 extra session without the skill before
  the first agent run (not scored)` and `Cost: 3 Claude Code sessions ...`; the summary shows
  `Reserved-name check: stopped the run (skill-name-reserved; 1 extra session, not scored, 0.0 s)`,
  `Tokens: input 2, output 4 (including the reserved-name check)`, the error, exit 6, one start.
- Free name: `Reserved-name check: passed (1 extra session, not scored, 0.0 s)`, `Tokens: input
  6, output 12 (including the reserved-name check)`, exit 0, three starts; `--json`
  `reservedNameCheck` = `{"status":"completed","errorCode":null,"durationMs":24,...,"passed":true}`.

Not verified: a real `claude` session (no consent for this issue); which entry a session uses on a
real collision; a flag change between the check and a later variant session.

## Problems and deviations

- `pkill -f "storybook dev -p 4402"` killed the agent's own shell (exit 144); Storybook was
  stopped, the temporary story moved out by hand. Lesson evidence added.
- The fake `claude` streams of the AC-18/AC-25 tests were shifted by one start (the check is
  start 1), and five A/B refusal tests now expect the check first (decision 3).

## Lessons recorded

- Evidence added to `.ai/lessons/2026-10-14-testing-processes-and-http.md` (`pkill -f` kills the
  agent's own shell; kill by PID). No new index entry: the lesson exists.

## Follow-ups

- Option 5 as possible hardening: #288.
- Option 1c (init-only probe) needs a consented live check before it can be considered.
