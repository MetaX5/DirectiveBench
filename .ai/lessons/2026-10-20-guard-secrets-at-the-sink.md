---
title: Guard secrets at the sink, not in one branch of the router
date: 2026-10-20
tags: [security, web, redaction]
source: .ai/runs/2026-10-20-issue-18-github-url-registration.md
---

# Guard secrets at the sink, not in one branch of the router

## Context

`registerRepositoryAction` sent rejected input back in `/repositories?path=…`. The "do not echo
input with `@`, `?` or `#`" rule lived only in the URL branch, which runs only when
`looksLikeRepositoryUrl` recognises the input. Malformed URLs (`https:/github.com/a/b?access_token=…`,
`http//user:token@github.com/…`, `github.com/a/b?token=…`) were classified as paths, failed path
validation and were echoed verbatim, so the token reached the browser history and request logs
(found by the Codex adversarial review of PR #51, round 2).

## Lesson

A classifier decides which branch handles input; it does not decide what the input contains. A
protection that depends on the classification is bypassed by every input the classifier gets
wrong, and malformed input is exactly what a user pastes by mistake. Put the check at the sink —
the one place that writes the input somewhere it persists (redirect URL, log, DB) — and base it on
the content itself (here: `@`, `?`, `#` or their percent-encodings), so no branch can skip it.

## How to apply

- Route every "send it back" path through one helper (`returnToForm` in `apps/web/lib/actions.ts`)
  that applies the secret check; do not add a second redirect that builds `?path=` itself.
- Test the guard with inputs the classifier misclassifies, not only with well-formed ones.
- Check the reader of the sink too: the page that renders `?path=` back into the field applies the
  same predicate (`mayCarryCredentials`).
