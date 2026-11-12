---
title: Pass --scope branch to the Codex adversarial review, or it reviews only uncommitted files
date: 2026-11-12
tags: [review, tooling, codex]
source: .ai/runs/2026-11-12-missing-occurrences-phase-1.md
---

# Pass --scope branch to the Codex adversarial review, or it reviews only uncommitted files

## Context

On PR #214 the first `codex-companion.mjs adversarial-review "<focus>"` run returned "approve"
with "No material findings in the working tree diff: it only records progress". The branch had
seven committed commits of code and one uncommitted run-log edit. With the default
`--scope auto`, a dirty working tree made the review target the working tree only, so none of
the feature code was reviewed. A run with no uncommitted change at all said "HEAD equals main"
when started from the main checkout instead of the worktree.

## Lesson

An "approve" from the Codex review is only as good as its `Target:` line. `--scope auto` picks
the working tree whenever anything is uncommitted, and the review diffs against the local
`main` of the checkout it runs in.

## How to apply

Run it from the feature worktree as
`node …/codex-companion.mjs adversarial-review --scope branch --base main "<focus>"`, make sure
local `main` equals `origin/main` first, and check that the output says
`Target: branch diff against main` before counting the verdict.
