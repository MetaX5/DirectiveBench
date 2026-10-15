---
title: Check that a pull request is still open before adding commits to its branch
date: 2026-10-15
tags: [git, github, workflow]
source: .ai/runs/2026-10-15-resolve-spec-code-gaps.md
---

# Check that a pull request is still open before adding commits to its branch

## Context

Follow-up work was committed to `feat/bootstrap-foundation` and pushed "to PR #1". The maintainer
had already merged PR #1, so the nine new commits were not in `main`, no CI ran for them, and the
agent reported them as part of the PR. The agent had also rewritten the merged PR's description
to describe work it did not contain. The maintainer had to point this out.

## Lesson

A branch name does not tell you whether its pull request is still open. Merged PRs do not pick up
later pushes, and their CI does not run again.

## How to apply

- Before committing follow-up work to an existing branch, run
  `gh pr view <branch-or-number> --json state,mergedAt`. If the PR is merged or closed, start a
  new branch from the current `main` (`git fetch && git checkout -b <new> origin/main`, or rebase
  the new commits onto `origin/main`) and open a new PR.
- Never edit the description of a merged PR to describe work that is not in it.
- After pushing, confirm that CI actually started for the new head commit (`gh pr checks`).
