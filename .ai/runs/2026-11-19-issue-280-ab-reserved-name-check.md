---
title: Detect a CLI-owned skill name at run time in A/B runs (issue 280)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #280, taken with the maintainer's approval; phase A (options and recommendation) before a product decision
status: in-progress
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

## Plan

Phase B is planned after the decision.

## Decisions

None taken without asking; see the recommendation above.

## Work performed

1. Read issue #280, PRs #276, #277 and #285 context in code and specs, SPEC-203 §4.1, SPEC-118
   FR-118-08/09/15, the ADR index, the orchestrator and the Claude Code adapter.
2. Inspected the `system/init` of the recordings of 2.1.302 and 2.1.325 (option 4 check, cost
   evidence).
3. Created the worktree `.ai/tmp/issue-280-wt` on `feat/issue-280-ab-reserved-name-check` from
   `origin/main` and this run log.

## Verification

Phase A is analysis only: no code changed, no tests run. No real `claude` session was started.

## Problems and deviations

None.

## Lessons recorded

None yet.

## Follow-ups

- Phase B after the decision.
- Option 5 as possible hardening (separate issue if wanted).
- Option 1c (init-only probe) needs a consented live check before it can be considered.
