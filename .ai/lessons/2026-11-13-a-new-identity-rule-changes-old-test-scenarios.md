---
title: A new identity rule changes the outcome of older tests whose scenario it now matches
date: 2026-11-13
tags: [testing, identity, database]
source: .ai/runs/2026-11-13-spec-126-phase-3.md
---

# A new identity rule changes the outcome of older tests whose scenario it now matches

## Context

SPEC-126 Phase 3 added rule 2 (moves) to `applyRepositoryScan`. A Phase 1 test, "names a skill
without a frontmatter name after the chosen occurrence directory", rescanned repository B with
the same nameless skill at the root instead of `tools/check`. That incidental relocation was "one
missing plus one new artifact" before, and became a move: the test expected two artifact names
and got one. Nothing in its title mentioned moves, so the failure looked like a regression in
the source-field rule.

## Lesson

An identity rule (moves, links) applies to every earlier test whose scan sequence happens to fit
its pattern: a path disappearing and identical content appearing elsewhere in the same scan is a
move. Such a failure is the new rule working, not a regression, but only if the test's intent
still holds after the change.

## How to apply

- When a new identity rule breaks an older test, check whether the scenario now matches the rule
  (same content, path changed within one scan). If it does, keep the test's intent and update
  the expectation with a comment naming the rule, as `identity.test.ts` now does.
- Write new identity tests with distinct content per artifact unless the shared content is the
  point, so later rules do not change them by accident.
