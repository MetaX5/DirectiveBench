---
title: Review PRs through om-auto-review-pr, and never hold a lock on a PR its author is pushing
date: 2026-10-22
tags: [process, review, agents]
source: .ai/runs/2026-10-22-issue-97-benchmark-cli.md
---

# Review PRs through om-auto-review-pr, and never hold a lock on a PR its author is pushing

## Context

Asked "can we approve #119?", the agent reviewed it with a general-purpose subagent and its own
prompt. The maintainer's reviewer asked whether the review skill had been used; it had not, so the
review skipped the skill's validation gate, review format, labels and handoff. Re-running it with
`om-auto-review-pr`, the agent claimed the PR (`in-progress` + assignee) while the author was still
pushing Codex-round fixes every few minutes: the claim tells the author's own `om-*` automation to
back off their PR, and a review of an old head would have been stale.

## Lesson

A PR review in this repository is `om-auto-review-pr <n>` (engine `om-code-review`), also when the
question is only "can we approve?". The claim it takes is a lock other automation honours: on
another author's PR that is still moving, it blocks the author.

## How to apply

- Run `om-auto-review-pr <n>`; when delegating, tell the subagent to invoke that skill, not to
  review "by the checklist".
- Before claiming another author's PR, check its last push (`gh pr view <n> --json commits`). When
  it is minutes old, ask the author whether the head is final, or review without claiming and
  submit only on the final head; release a claim at once if the author starts pushing.
- Name the reviewed head in the review; re-check it right before `review-pr`.
