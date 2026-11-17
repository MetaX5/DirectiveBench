---
title: Install a nameless skill under its folder name (issue 245)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: issue 245, maintainer decision 2026-11-17 (option C)
status: in-progress
branch: fix/issue-245-nameless-skill-install-name
specs: [SPEC-203, SPEC-118, SPEC-103, SPEC-107, SPEC-108]
---

# Run: Install a nameless skill under its folder name (issue 245)

## Objective

A skill without a frontmatter `name` is installed by the Claude Code adapter (and the mock agent)
under the folder its repository's agent sees, not under the immutable slug. Acceptance criteria:
the rule is in SPEC-203; adapter tests cover a renamed nameless skill and a collision; 100%
coverage; mock agent only.

## Plan

1. Decision material (`.ai/tmp/issue-245-decisions.md`), maintainer picked option C with answers
   1-8 (see Decisions).
2. Spec first: SPEC-203 §4.1 and AC-5, SPEC-118 FR-118-04/08/31 and §8, SPEC-103 §14 case 9 and
   the `ArtifactBundle` interface, SPEC-107/SPEC-108 mock convention.
3. `ArtifactBundle.folderName?` in core; a new database loader `getInstallableArtifactBundle` in a
   new repository file (`artifacts.ts` is owned by the parallel issue 239 run); runner and CLI use it.
4. Adapter: name = frontmatter `name` ?? folder ?? slug; directory = slug when named, else the
   name; mock agent the same; `installedSkillName` in the run metadata; plan line.
5. Red-first tests, gate, real run with the built CLI and the mock agent, follow-up issues, Codex
   review, `om-auto-review-pr`.

## Decisions

- Maintainer, 2026-11-17: option C; invalid folder names refused with `skill-name-unsupported`;
  skills with a frontmatter `name` keep the slug directory; collisions with CLI-listed names and a
  plan-time `/<slug>` warning are follow-up issues; the run-time name is recorded in the metadata
  and shown in the plan; the mock agent follows the rule; one skill per workspace is written into
  SPEC-203 §4.1, collision suffixes deferred. No ADR (an adapter fidelity rule recorded in the spec).

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups
