---
title: Specify repository workflow benchmarks and skill chains (issue 124)
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #124 (claimed by cieslinho), run through om-auto-write-spec and om-spec-writing --autonomous
status: completed
branch: docs/issue-124-repository-workflow-benchmarks
specs: [SPEC-127, SPEC-118, SPEC-203, SPEC-108, SPEC-111, SPEC-112, SPEC-123]
---

# Run: specify repository workflow benchmarks and skill chains (issue 124)

## Objective

Issue #124 (E05-T01) asks for a dedicated draft spec for generic repository-workflow benchmarks
(D02 chains, product brief S3) and a bounded follow-on backlog, before any implementation. Done
when the spec defines snapshot, instruction composition, stages, state, approval model,
results/provenance and a fair comparison contract; separates outcome from workflow checks;
defines isolation, consent and deterministic tests; carries one generic staged reference
scenario and an implementation slice; and records product/safety questions with owners. The
design must not claim S1 supports workflows.

## Plan

1. Read AGENTS.md, the spec index, lessons, the product brief, D02, D08, D09, SPEC-118 (§1–5,
   FR-118-06/08/15/26/27/33, §19), SPEC-108 §8.1, SPEC-111 FR-111-43, SPEC-203 §7, ADR-0007 and the
   `agent_runs` schema.
2. Write SPEC-127 skeleton-first; resolve the open questions with autonomous defaults and mark
   the safety-relevant one for human confirmation.
3. Fresh-context adversarial review of the spec; apply confirmed findings.
4. Add the index row, commit, open a design-only PR (draft, because one default needs human
   confirmation), post the defaults comment on the PR and the issue.

## Decisions

- Branch `docs/issue-124-…` instead of the skill's `spec/…` prefix, per the operator's
  instruction and AGENTS.md §4 branch prefixes.
- Next free id SPEC-127 (checked the index and the spec changes of open PRs).
- Eight open questions resolved with autonomous defaults (spec §"Resolved assumptions"); Q5
  (simulated outside tools through a new restricted-shell permission profile) is marked
  `⚠ NEEDS HUMAN CONFIRMATION` because it widens the agent's tool surface and rests on an
  unverified Claude Code behaviour; the PR stays draft until the maintainer confirms it.
- The backlog is proposed in spec §22 and not filed: the issue asks for it to follow from the
  design, and filing waits for the maintainer's Phase 0 decisions.
- No UI mockups: the only UI is a read-only extension of the run detail page, deferred to Phase 4.

## Work performed

1. Read the context listed in the plan; checked open PRs for spec ids (SPEC-127 free).
2. Wrote SPEC-127 (`.ai/specs/2026-11-19-repository-workflow-benchmarks.md`) and its index row.
3. Fresh-context staff-engineer review of the spec: 3 critical, 5 high, 5 medium, 3 low.
   Applied: instruction-file members replace the snapshot copy per attempt instead of being
   refused (the reference scenario was unrunnable); ledger nonce and `ledger-tampered`, and a
   full shell-escape list for the live check AC-12 with a stated low prior; gated stages need
   `mayChange` with a required `stage-boundary` check; stage checks accept workflow assertions
   and the reference scenario uses only concrete assertions; scoring of `not-evaluated` and of
   agent-caused workflow errors made explicit; key and `flagsHash` placeholders completed;
   comparability across different routes defined; `interrupt` renamed honestly as a resume
   notice; approval also for `edit-and-simulated-tools`; reserved-name check for sets (FR-127-03a);
   checks after the last stage; ACs 2, 4, 6 and 12 made concrete; ADR and lesson links fixed;
   D10 and E05 ids marked proposed. Not applied: the recommendation to split simulated tools and
   the snapshot command into separate specs; recorded in Q6 for the maintainer.
4. Commits: spec and index; run log.

## Verification

Docs-only change. Every relative link in SPEC-127 resolves to an existing file (scripted check). Prettier ignores `.ai` and `*.md`; no code, package or test changed, so the
quality gate has nothing to check for this change. Links in the spec were checked by reading
the referenced sections. Not verified: any behaviour of the design (nothing is implemented);
the Claude Code Bash-rule assumption behind FR-127-18 (needs the opt-in live check AC-12).

## Problems and deviations

- The skill's default branch prefix `spec/` was replaced by `docs/` (operator instruction).
- The PR body follows the house layout (lesson 2026-10-21) instead of the skill template.

## Lessons recorded

None: no bug fixed, no human correction received during the run.

## Follow-ups

- Maintainer: confirm or change Q1–Q8 (Phase 0), record D10 and an ADR for Q5.
- Then file the backlog of spec §22 with `om-backlog`.
