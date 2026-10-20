---
title: GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL do not stop git from loading an enclosing repository's config
date: 2026-10-20
tags: [git, security, repository-sync]
source: .ai/runs/2026-10-20-issue-18-github-url-registration.md
---

# GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL do not stop git from loading an enclosing repository's config

## Context

Hosted git (PR #51, issue #18) isolated its configuration with `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null` and an empty `HOME`, and its tests proved the user's global config
had no effect. A Codex adversarial review found that git still *discovers* a repository from its
working directory: with `--data-dir` inside a git work tree, `ls-remote` (run in
`<dataDir>/cache/git-home`) walked up, found the enclosing `.git` and applied its `.git/config` —
`url.*.insteadOf` (also through `include.path`), `http.extraHeader`, `http.sslVerify=false`,
`http.proxy`, `credential.helper`. A fetch into a broken cache (e.g. `HEAD` missing, so the cache is
no longer a repository) went further: it walked up to the enclosing repository and fetched its
`origin` into it. `git clone` and `git version` do not discover a repository; a broken config line
in the enclosing `.git/config` is a quick tripwire to see which commands read it.

## Lesson

Config isolation needs two things: no system/global config *and* no repository discovery. A git
call must either name its repository explicitly (`GIT_DIR`/`--git-dir`) or run where discovery stops
immediately (`GIT_CEILING_DIRECTORIES` = the parent of its working directory; the working directory
itself is still checked, so it must be a directory you own and keep empty). `GIT_CEILING_DIRECTORIES`
is a list split on the path delimiter (`:`, `;` on Windows): a path containing it silently becomes
several entries and discovery walks up again, so refuse such a path (fail closed).

## How to apply

- In `packages/runner/src/hosted-git.ts`, `buildHostedGitEnv(…, gitDir)` sets `GIT_DIR` for cache
  steps and `GIT_CEILING_DIRECTORIES` for all steps; steps without a repository run in `HOME`.
  Any new hosted git call must pass its `gitDir` (or `null`), never a bare `cwd`.
- Test isolation with the data directory *inside* a git work tree whose `.git/config` is hostile,
  arm the fixture first (plain `git config --show-origin --list` below the data dir shows it), and
  assert the effective config of the hardened invocation (`config --show-origin --list` shows only
  `command line:` and the cache's own `config`).
- Remember the broken-cache case: a directory that stopped being a repository makes git walk up.
