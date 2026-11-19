---
title: A second `no-restricted-syntax` block in flat config silently drops the first block's selectors
date: 2026-11-19
tags: [lint, eslint, testing]
source: .ai/runs/2026-11-19-issue-123-no-dashes-in-ui-copy.md
---

# A second `no-restricted-syntax` block in flat config silently drops the first block's selectors

## Context

Issue 123 added `no-restricted-syntax` selectors that forbid en and em dashes in app-authored
copy. `apps/web/{app,components,stories,.storybook}` already had a `no-restricted-syntax` block
(`designSystemComponents`: raw `<button>`, `<input>`, `<table>`). ESLint flat config merges
blocks per rule by **replacing** the options of an earlier block with those of a later one for
the same file, so a separate copy block over the same globs would have switched off the design
system selectors without any warning; `pnpm lint` stays green either way. A mutation run proved
it: moving the copy selectors into their own block over `apps/web/app` made the lint test's
"raw `<button>` is still an error" case fail.

A second, smaller trap: text written through the agent's file tools (or a Python heredoc) with
`\u2013` / `\u2014` escape sequences arrived on disk as the real characters twice in the same
run, in a test constant and in an `eslint.config.mjs` comment.

## Lesson

- One rule id has one options list per file. Put every selector of `no-restricted-syntax` (and
  likewise `no-restricted-imports`, see the 2026-10-15 lesson) for a file into the one block
  that covers it: a shared constant spread into each block, with globs that do not overlap.
- Prove a lint rule with a test that loads the real `eslint.config.mjs` through ESLint's API
  (`new ESLint({ overrideConfigFile }).lintText(source, { filePath })`) and asserts both the new
  selectors and the old ones on the same file.
- Escapes you meant to write may land as the characters they encode; check the bytes.
- `new ESLint()` is cheap but the first `lintText` loads every plugin of the config: 8.2 s on the
  loaded CI runner. Warm it up in `beforeAll` with a named timeout and give the cases the same
  budget, or the first case times out in CI only.

## How to apply

- Before adding a block with a rule that already exists in `eslint.config.mjs`, search the
  file for the rule id and extend the existing block instead.
- Keep `apps/web/test/ui-copy-lint.test.ts` green; add a case there when a new selector set or
  scope is added.
- After writing escapes, run `grep -nP '[\x{2013}\x{2014}]' <file>` to confirm none were decoded.
