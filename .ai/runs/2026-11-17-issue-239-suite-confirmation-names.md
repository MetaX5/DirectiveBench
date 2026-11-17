---
title: Suite assignment confirmations name a shared-name suite with its ID (issue 239)
date: 2026-11-17
agent: Claude Code / claude-opus-5-5
trigger: issue 239 (follow-up of the PR #238 review), run by the coordinator in two phases
status: in-progress
branch: fix/issue-239-suite-confirmation-names
specs: [SPEC-101, SPEC-014]
---

# Run: Suite assignment confirmations name a shared-name suite with its ID

## Objective

After an assign or unassign on an artifact's Benchmarks tab, the status line named the suite by
name only, although suite names repeat. It must add ", ID <id>" when another suite has the name,
the way the picker does (decision L1), for sighted users and screen readers alike; a unique name
stays as it is.

## Plan

1. Phase 1 (decision material, no commits): prototype the strings, seed same-named suites in a
   QA database, screenshot both themes at 1280 and 320, write the open questions.
2. Phase 2 (after approval): red-first tests (database, web lib, e2e), the transactional
   design, spec text, gate, browser QA, Codex adversarial review, `om-auto-review-pr`, CI.

## Decisions

Approved by the maintainer on 2026-11-17 from the phase 1 screenshots:

1. The ID only on a name clash (the picker's L1 rule), never for a unique name.
2. Plain text in the status line (no mono span): the visible text is the announced text.
3. The same rule for "is already assigned" and "was already unassigned".
4. The clash is read in the action's transaction: `assignArtifactSuite` and
   `unassignArtifactSuite` return `suite: { name, slug, nameShared }` (`suiteNameShared`), and
   the web app words it with `suiteLabel` (shared with `suiteOptions`, built on `suiteSubject`).
5. The clash is measured at the time of the action; a suite imported between render and submit
   can add the ID although the option had none. Accepted.

## Work performed

- `6d8f9de` test: database outcome shape and clash flag, web messages, e2e confirmations (red).
- `96a66c9` fix: `AssignmentSuite` in the outcome, `suiteLabel` in `artifact-metadata.ts`.
- Spec SPEC-101 §11 "Detail editing" (Suites): the confirmation strings and the rule.

## Verification

Red first: with only the test commit, `packages/database` "assigns and unassigns a suite…" and
"says when another suite has the name…" failed, and `apps/web` "adds the suite ID to every suite
message…" failed with `- "Assigned Input validation, ID mock-input-validation. Run it from its
suite page."` / `+ "Assigned Input validation. Run it from its suite page."`.

## Problems and deviations

None so far.

## Lessons recorded

None so far.

## Follow-ups

None so far.
