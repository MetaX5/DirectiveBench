---
title: A conflicting PR gets no pull_request CI run — check mergeable before waiting on CI
date: 2026-10-22
tags: [ci, github, process]
source: .ai/runs/2026-10-22-issue-94-document-assertions.md
---

# A conflicting PR gets no pull_request CI run — check mergeable before waiting on CI

## Context

PR #105 received two pushes (6ac90df, 0ceaec3) after PRs #107 and #108 had merged into `main`.
The PR had become `CONFLICTING`/`DIRTY`, so GitHub could not build a merge ref and never started
the `pull_request` CI workflow; only CodeQL ran. The agent kept polling `gh pr checks`, which
still listed results from an earlier head and reported nothing new.

## Lesson

GitHub runs `pull_request` workflows on the merge ref. A PR that conflicts with its base has no
merge ref, so no CI run starts for any new push, and waiting never ends. Checks listed for the PR
may belong to an older head.

## How to apply

- After every push, run `gh pr view <n> --json mergeable,mergeStateStatus` first. If it says
  `CONFLICTING`, merge the base branch and resolve the conflicts before waiting on CI.
- Confirm a run really started for the new head with
  `gh run list --branch <branch> --json headSha,status,conclusion`, and match `headSha` with
  `git rev-parse HEAD`.
- Bound every CI wait loop and make it fail loudly when no run exists for the head.
