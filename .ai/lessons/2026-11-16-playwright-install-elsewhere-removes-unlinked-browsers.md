---
title: A Playwright install in another project removes browser builds no install of this checkout registered
date: 2026-11-16
tags: [testing, e2e, storybook, playwright, tooling]
source: .ai/runs/2026-11-16-issue-66-type-follows-source.md
---

# A Playwright install in another project removes browser builds no install of this checkout registered

## Context

During issue 66 the e2e run passed at 16:58; at 17:50 `pnpm test:e2e` failed every test in
0 ms and `pnpm test:storybook` ran no tests: `browserType.launch: Executable doesn't exist at
~/.cache/ms-playwright/chromium_headless_shell-1254/...`. Nothing in the run had touched the
cache. `~/.cache/ms-playwright/.links/` showed a link written at 17:10 by a `playwright install`
in an unrelated project on the same machine, and no link for this repository.

## Lesson

`playwright install` garbage-collects every browser build that no entry in
`~/.cache/ms-playwright/.links/` still references. A link is written only by
`playwright install` itself, pointing at the `playwright-core` package of the checkout that ran
it. A checkout or worktree that only *uses* an already downloaded browser (as every DirectiveBench
worktree does after `pnpm install`) has no link, so the next install anywhere else on the machine
can delete the browser this repository needs (here `chromium_headless_shell-1254` for Playwright
1.65.0). The failure looks like a broken install, not like a deletion.

## How to apply

- When e2e or Storybook tests all fail with "Executable doesn't exist", list
  `~/.cache/ms-playwright/` and `.links/` before suspecting the change under test.
- Repair it from the worktree with a private temporary directory:
  `TMPDIR=$(mktemp -d /var/tmp/pw-XXXX) pnpm --filter @directivebench/web exec playwright install
  chromium-headless-shell chromium`, then remove that `TMPDIR`. This also writes a link for the
  worktree, so later installs elsewhere keep the build while the worktree exists.
