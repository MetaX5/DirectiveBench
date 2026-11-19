---
title: The Codex adversarial review cannot run the gate in its sandbox; a findings-free needs-attention is a validation note
date: 2026-11-19
tags: [review, codex, tooling]
source: .ai/runs/2026-11-19-issue-262-user-level-folder-confirmation.md
---

# The Codex adversarial review cannot run the gate in its sandbox; a findings-free needs-attention is a validation note

## Context

On issue 262 the Codex adversarial review (`--scope branch --base origin/main`) returned
`Verdict: needs-attention` with "No material findings". Its only reason: `pnpm typecheck`,
`pnpm test` and `pnpm verify:pack` failed in its read-only sandbox (they write `.turbo`,
coverage and tarballs), and `pnpm build` only replayed the turbo cache.

## Lesson

The review's verdict mixes code findings with whether it could validate the branch itself. A
`needs-attention` without findings says nothing about the code; it is not an approval either.

## How to apply

Read the findings, not only the verdict line. When the only blocker is validation the sandbox
could not run, run the full gate yourself, record the results in the PR, and run another round
whose prompt context (PR body or run log) carries those results; report the verdict verbatim and
say why it is not a code finding. Never count it as an approval.
