---
title: Write the S1 spec — benchmark own skills with Claude Code against registry artifacts
date: 2026-10-22
agent: Claude Code / claude-opus-5-5
trigger: user request (om-auto-write-spec, brief .ai/specs/briefs/2026-10-22-benchmark-own-skills-s1.md)
status: completed
branch: spec/benchmark-own-skills-s1
specs: [SPEC-118, SPEC-203, SPEC-107, SPEC-108, SPEC-110, SPEC-111, SPEC-112, SPEC-113, SPEC-009, SPEC-013]
---

# Run: Write the S1 spec — benchmark own skills with Claude Code against registry artifacts

## Objective

Turn the S1 brief into a draft feature spec on a design-only PR, update the existing specs it
changes, record product decision D08 in the product brief, and record the human correction about
generic design as a lesson.

## Plan

1. Isolated worktree on `spec/benchmark-own-skills-s1` from `origin/main`; copy the brief in.
2. Read AGENTS.md, the specs index, lessons, the product brief and SPEC-203/107/108/110–113/013.
3. Write SPEC-118 (next free feature id) with resolved assumptions for what the brief leaves open.
4. Edit the affected sections of existing specs for consistency; add D08 and its decision file.
5. Lesson + index entry; scope-cohesion review by a fresh-context subagent; format check.
6. Commit, push, open the PR with labels and the assumptions comment.

## Decisions

- Thirteen autonomous defaults for what the brief left open, listed in SPEC-118 "Resolved
  assumptions"; Q5 (`--approve-commands` as a CLI approval channel) is marked
  `⚠ NEEDS HUMAN CONFIRMATION` because roadmap M3 says approval happens in the UI, so the PR
  stayed draft until the maintainer confirmed Q5 on 2026-10-22.
- The brief's choices that change approved-looking defaults were applied as the maintainer's
  decisions: SPEC-203 §7 `authMode` default becomes `subscription` (was "user must choose").
- The design-genericity correction is a rule for all future work, so it went into `AGENTS.md` §7
  as well as a lesson.
- `.ai/specs/briefs/` was added to the specs README layout (the brief must be committed with the
  spec); `AGENTS.md` §1's directory list does not name it yet (follow-up).
- The worktree lives under the primary checkout's `.ai/tmp/` (skill convention; a cross-device
  move to the scratchpad failed) and is removed at the end.

## Work performed

- Copied the brief into the worktree; wrote SPEC-118
  (`.ai/specs/2026-10-22-benchmark-own-skills-s1.md`) and indexed it.
- Updated sections of SPEC-203, SPEC-107, SPEC-108, SPEC-110, SPEC-111, SPEC-112, SPEC-113,
  SPEC-114, SPEC-009 and SPEC-013 (listed in SPEC-118 §17); all stay `draft`.
- Product brief: D08 added (supersedes D01), D07 answered early, A02/A04 results, Scope Now/Later,
  Decision summary, Definition of Ready addendum; decision file D08; D01/D07 statuses.
- Lesson `2026-10-22-design-generic-not-for-the-example.md`, index entry, AGENTS.md §7 rule.
- A fresh-context subagent reviewed SPEC-118 (scope cohesion, consistency, security, speculative
  surface). Applied: normalised flags hash and `reportedModels` drift as a warning; FR-118-06
  (fixture settings that run code or reroute auth/billing) and FR-118-07 (edits confined to the
  workspace); FR-118-15 (stop on auth/quota errors); FR-118-39 (nothing persisted before the
  final transaction; approval recorded only after confirmation); `--max-budget-usd` only with an
  API key; slug confinement for `init`; ACs 14–20; trimmed unrequested assertion options
  (`level`, `exact`, `mode: any`, `match: all`, `table.headerPattern`, `row.column`) and
  `init --dir/--version`; split the CLI and UI into separate phases and moved the web guard into
  phase 2; SPEC-115 change scheduled in phase 2.

## Review round: Codex adversarial review, round 1 (2026-10-22)

Four HIGH findings; each was checked against the spec text and, for 1–3, against the Claude Code
docs (skills, hooks, cli-reference, tools-reference, headless; recorded as SPEC-203 C8–C10).
All four were valid.

1. **Permission profiles omitted skill invocation.** Confirmed: `Skill` is a built-in tool that
   requires permission (tools reference) and the profile's `--tools` list left it out, so the
   installed skill could never be invoked. Resolved: per-artifact-type profiles in SPEC-203 §7
   (`Skill` in `--tools`, only `Skill(<name>)`/`Skill(<name> *)` allowed; none for instruction
   types); SPEC-118 FR-118-08 (skill access, A/B name rule), FR-118-09 (`skillActivation` per run:
   not loaded → `infrastructure-error` `artifact-not-loaded` and stop; loaded but not invoked →
   scored with warning `artifact-not-invoked` and an invocation rate on every surface; a `none`
   baseline invoking the tested skill → `not-comparable`), AC-21, AC-22 (opt-in live check with
   the exact production argv), §15 live check, SPEC-203 AC-11.
2. **Approval ignored code inside artifact versions.** Confirmed and wider than reported: besides
   frontmatter `hooks`, `` !`cmd` `` placeholders and `allowed-tools` grants also take effect in
   an untrusted `-p` run. Resolved by refusal (the simpler safe option): FR-118-26 inspects
   candidate and baseline bundles and refuses with `artifact-executes-code` (fail closed); argv
   adds `disableSkillShellExecution` as a second line; FR-118-06 extended to fixture skills,
   subagents and plugin manifests; AC-23; SPEC-203 §8, §9, AC-12. Approval bound to
   artifact-version hashes is future work (§19).
3. **Observed model changes still produced verdicts.** Confirmed (FR-118-04 made a reported-model
   difference a warning). Resolved: `executionModel` from `system/init` must be identical for all
   agent runs (`not-comparable`, `execution-model-mismatch`), is hashed into the comparability key
   (§8.3), auxiliary `modelUsage` models are recorded with warning `auxiliary-models`; AC-18
   rewritten; SPEC-112 FR-112-04/08/09 and §14, SPEC-111 FR-111-43/44, SPEC-113 FR-113-10,
   SPEC-203 §4/§4.2, AC-13.
4. **Arbitrary regexes defeated the runtime bound.** Confirmed: `(a+)+$` took 279 ms / 1.1 s /
   4.5 s at 22/24/26 characters on Node 24 (≈ 5 min at 32). Resolved: FR-118-46 — every user
   pattern (new types and `file-contains`) runs in a `node:worker_threads` worker with
   `ASSERTION_REGEX_TIMEOUT_MS` = 2 000 ms, terminated on deadline or abort → assertion error,
   agent run `infrastructure-error` `assertion-error`; literals matched by linear scans;
   NFR-118-02, §8.1, §8.2 (`AssertionResult.error`), §15 adversarial/heartbeat/cancellation
   tests, AC-24, phase 1 step 3; SPEC-107 §8.3 and SPEC-108 FR-108-10 aligned. No RE2.

Resolved-assumption rows Q9 updated and Q14–Q16 added. Lesson
`2026-10-22-installing-a-skill-is-not-activating-it.md` recorded.

## Verification

- `prettier --check .` (repository config; Markdown and `.ai/` are prettier-ignored): passed.
- Relative links in every changed or new document resolve: 0 broken.
- `pnpm lint` / typecheck / tests: not run — docs-only change, no file in their scope changed.
- Not verified: anything about Claude Code behaviour beyond what SPEC-203 already records; the
  `system/init` auth-source field is marked as an assumption in FR-118-06.
- Review round 1: Claude Code behaviour checked against the docs only (no live run). Still
  assumptions, to be settled by the opt-in live check (AC-22): the init field listing skills,
  the `Skill` tool input field, `disableSkillShellExecution` under `--setting-sources`, whether
  `allowed-tools` can re-add a tool removed by `--tools`, and which copy wins when a user-level
  skill has the tested skill's name.

## Problems and deviations

- Mockups and current-app screenshots were skipped: no `.ai/qa/test-env.json` descriptor and
  `agent-browser` is not installed.

## Lessons recorded

- [2026-10-22-design-generic-not-for-the-example.md](../lessons/2026-10-22-design-generic-not-for-the-example.md)
- [2026-10-22-installing-a-skill-is-not-activating-it.md](../lessons/2026-10-22-installing-a-skill-is-not-activating-it.md)

## Follow-ups

- Maintainer: the terms review of SPEC-203 §3.2 before a release with subscription as default.
- Tracker: close or annotate #30 (D07 answered) and #26 (A04 skipped), and park #20/#21/#22.
- Decide whether `AGENTS.md` §1 should list `specs/briefs/`.
- Next: `om-auto-implement-spec .ai/specs/2026-10-22-benchmark-own-skills-s1.md` phase 1.
