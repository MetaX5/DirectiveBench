# ADR-0015: A session without the skill checks the skill name before every A/B run

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** Project maintainer (decisions on issue #280, 2026-11-19; pending review of this
  record)
- **Related:** [SPEC-203](../specs/2026-10-14-integration-claude-code.md) §4.1 (names Claude Code
  lists itself, run-time check); [SPEC-118](../specs/2026-10-22-benchmark-own-skills-s1.md)
  FR-118-08 and FR-118-15; issues #257, #275, #278 and #280; run log
  [2026-11-19-issue-280-ab-reserved-name-check](../runs/2026-11-19-issue-280-ab-reserved-name-check.md)

## Context

An installed skill whose name Claude Code also lists itself (a skill the CLI keeps with
`disableBundledSkills`, or a built-in slash command) may shadow the CLI's own or be shadowed by
it, so a benchmark could measure the wrong thing. Two lines guard against it:

- a static list of names observed up to one `claude` version, checked before any job (issue 257,
  refreshed by issue 278);
- a run-time check of the session's `system/init` (issue 275). The live check of `claude` 2.1.325
  showed that a name owned by both the CLI and the installed skill is listed **once**, exactly
  like an installed skill without a collision. Only a session that installed nothing can show the
  CLI's own entry: the baseline of a `none` run.

An A/B run (candidate version against a baseline version of the same skill) installs the skill in
both variants, so it has no such session. A name that a newer `claude` adds and the static list
does not yet hold (2.1.325 added `/ultrareview`) went undetected. If the CLI's own entry wins, both
variants measure it and the comparison reports no difference between two versions it never ran.
`claude` releases often (2.1.302 on 2026-10-26, 2.1.325 on 2026-11-19), so the static list is
usually behind the user's installed version.

## Decision

1. Before the first repetition of every A/B run of a `skill-md` artifact, the engine runs **one
   extra session without the skill** (the reserved-name check) when the adapter offers it
   (`AgentAdapter.needsReservedNameCheck`). Only the Claude Code adapter offers it; the mock agent
   does not, so mock runs are unchanged.
2. The session uses the **same argv, model, environment, auth mode and timeout** as the variants,
   in an empty pinned workspace with nothing installed, and a fixed minimal prompt
   ("Reply with the single word OK."). The adapter applies the existing rule for a session that
   installed nothing: any entry of the skill name in its `system/init` is the CLI's own.
3. A listed name stops the benchmark run with `skill-name-reserved` before any variant starts.
   Any other failure of the check (auth, rate limit, timeout, no `system/init`) also stops it,
   fail closed, with the session's own code, or `reserved-name-check-failed` when it has none; the
   message says the failure came from the reserved-name check.
4. The check is never scored and never part of the RED/GREEN or A/B results. Its outcome (status,
   code, duration, usage, `claude` version and session model) is stored with the benchmark run in
   its `environment` record as `reservedNameCheck`, without a schema change.

## Alternatives considered

- **Compare with a recorded `system/init` of the same version without the skill** (from earlier
  `none` runs on this machine). Nothing usable is stored today, a user who only runs A/B has no
  record, and a record can be stale for names gated by plan or flags; it still needs this check or
  a refusal for the cold start.
- **Refuse A/B runs on a `claude` newer than the static list's version** (or mark them not
  comparable). Zero cost, but nearly every A/B run would be refused until a DirectiveBench release
  refreshes the list; marking spends the whole run and then discards the verdict.
- **Look for unknown built-ins in the candidate session** (`slash_commands` minus `skills` minus
  the static list). The colliding entry merges with the installed skill, so it drops out of the
  difference: the heuristic misses exactly the name that collides.
- **Check the path of an invoked skill** ("Base directory for this skill"). Works only when the
  skill was invoked and relies on undocumented text; filed as a follow-up hardening, not a
  replacement.

## Benefits

- Detects the colliding name itself on any `claude` version, including names gated by plan, auth
  mode or feature flags on this machine, which a static list cannot know.
- Reuses the run-time rule of issue 275; no database migration and no version parsing.
- Stops before any variant spends money, and surfaces a broken login before the first real session.

## Drawbacks

- One extra short session per A/B run. Evidence: the issue 275 live check, the same minimal prompt
  on haiku with `--effort low`, took 1 turn, 990 ms and $0.00058 (about 7.1k input tokens, mostly
  cache reads). A larger model costs more (not measured). On a subscription it uses a small part of
  the plan quota.
- A name the CLI adds between the check and a later variant session is not detected (a flag
  change within one run). A name that is reachable but not listed (the `/checkup` alias) stays the
  static list's job.

## Consequences

- `AgentAdapter` gains the optional `needsReservedNameCheck(artifact)`; adapters without it are
  never checked.
- `runBenchmark` takes an `onReservedNameCheck` callback; the runner stores the outcome in
  `benchmark_runs.environment.reservedNameCheck`.
- SPEC-203 §4.1 replaces the A/B residual with this rule; SPEC-118 FR-118-08 and FR-118-15 name
  the check and its stop behaviour.
- How the CLI and the web app show the check (label, cost) is a separate, maintainer-approved UI
  change.

## Status

Proposed. Revisit if Claude Code exposes the CLI's own names without a session (for example a
documented listing command), or if a recorded `system/init` per version becomes available
locally without a session.
