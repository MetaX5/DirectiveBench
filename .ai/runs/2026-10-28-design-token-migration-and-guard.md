---
title: Design-token migration and design-system guard in CI (SPEC-121)
date: 2026-10-28
agent: Claude Code / claude-opus-5-5
trigger: maintainer request ("robimy 134" → #132 first), issue #132, spec PR #136
status: in-progress
branch: feat/design-token-migration-and-guard
specs: [SPEC-121, SPEC-120]
---

# Run: design-token migration and design-system guard in CI

Source doc: .ai/specs/2026-10-28-design-token-migration-and-guard.md

## Objective

Implement SPEC-121 (#132): CI guards for design-system use, then migrate raw type and spacing
utilities to the SPEC-120 tokens with no visual change. Acceptance criteria: SPEC-121 §16.

## Plan

Goal: one way to set a text size or gap, enforced in CI, with pixel-identical pages.
Scope: `apps/web/{app,components}`, `apps/web/test/design-tokens.test.ts`,
`eslint.config.mjs`, `apps/web/tokeny.md`, a new `apps/web/design-system-scope.json`.
Non-goals: new token values, colour changes, Storybook (#134), screenshot baselines in CI.
Risks: a spacing migration that changes meaning (mitigated by the pixel comparison); regexes
that are too broad (mitigated by negative test cases).

## Decisions

The maintainer accepted all six autonomous defaults of SPEC-121 (Q1–Q6) on 2026-10-28.

## Work performed

## Verification

## Problems and deviations

## Lessons recorded

## Follow-ups

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: guards (red first)

- [ ] 1.1 Shared scope file read by the token test
- [ ] 1.2 tokeny.md CSS property column and sync test
- [ ] 1.3 Arbitrary-value rule with allowlist
- [ ] 1.4 ESLint raw-element rule with the markdown table exception

### Phase 2: migration

- [ ] 2.1 Before screenshots on origin/main
- [ ] 2.2 text-xs/text-sm rule and type migration
- [ ] 2.3 Spacing migration by purpose
- [ ] 2.4 Decision D11 in tokeny.md and SPEC-120 pointer
- [ ] 2.5 After screenshots, comparison and full gate
