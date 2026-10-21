---
title: PR descriptions follow the repository's house layout, not a skill's default template
date: 2026-10-21
tags: [process, github, pull-requests]
source: .ai/runs/2026-10-21-issue-49-frontmatter-source-cap.md
---

# PR descriptions follow the repository's house layout, not a skill's default template

## Context

PR #84 was opened by `om-open-pr` with the skill's default body template (`🎯 What changes`,
`📋 Scope`, `💥 Compatibility`, `🧪 Validation`). The maintainer's PRs (#68, #71, #72, #73) use a
different, consistent layout, and a human reviewer asked for the same style. The same PR had
`skip-qa`, while the maintainer's backend fixes (e.g. #68 in the runner) carry `needs-qa`.

## Lesson

The house layout of existing PRs wins over a skill's generic template. It is:

1. `## Summary` — the problem and its effect; for a fix, **Root cause.** and **Fix.** paragraphs;
   bullets or a table for details (measurements, audited failure points).
2. `## ⚠️ Decision needed` — only when a direction call is open.
3. `## Verification` — a `Command | Result` table for the gate, then "Red first", the real-app
   run and an explicit "Not verified" line.
4. `## Review` — only after independent review rounds (round, SHA, verdict).
5. `## Links` — specs with sections, run log, lessons, origin.
6. `## Follow-ups` — open items, when any.
7. `## Decisions touched` — "None from the product brief." when none.
8. `Closes #N`, then the generated-with line.

New PRs start with `review` and `needs-qa`; use `skip-qa` only if the maintainer does.

## How to apply

Before opening a PR, read the body and labels of the two or three most recent merged PRs by the
maintainer (`gh pr list --state merged --limit 5`, `gh pr view <n> --json body,labels`) and
follow their layout and labelling, even when an `om-*` skill supplies its own template.
