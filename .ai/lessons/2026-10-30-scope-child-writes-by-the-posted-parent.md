---
title: A form that posts a parent id and a child id must scope the write by both
date: 2026-10-30
tags: [security, database, web]
source: .ai/runs/2026-10-30-blind-review-run-scope.md
---

# A form that posts a parent id and a child id must scope the write by both

## Context

Issue #170: `recordBlindVerdictAction` and `revealBlindReviewAction` parsed `benchmarkRunId`
but used it only to revalidate the page; the repository writes took just the pair or review id.
A form posted with run A's id and run B's pair recorded a verdict on run B. Every existing test
posted matching ids, so nothing failed, and the conditional write already looked "safe" (it
checked verdict and reveal state in one statement).

## Lesson

A parent id a form carries is either part of the write's condition or it is decoration that
lets ids that do not belong together pass. The one conditional statement that guards the write
(SPEC-014) must also match the parent, and the follow-up read that explains a refusal must
report the mismatch before any other state (`other-run` before `revealed` or `already-decided`).

## How to apply

- When an action parses an id it does not pass to the repository, treat it as a bug: pass it and
  match it in the `WHERE` of the write (or the subquery that selects the parent).
- Test every such action with a forged post: ids of two different parents, and assert the
  database is unchanged, not only the returned message.
