---
title: Classify git errors from output recorded with the exact hardened invocation, not from memory
date: 2026-10-20
tags: [git, security, repository-registration, testing]
source: .ai/runs/2026-10-20-issue-18-github-url-registration.md
---

# Classify git errors from output recorded with the exact hardened invocation, not from memory

## Context

Issue #18 maps a private or missing GitHub repository to "not found or not public". The patterns
were written from git's familiar message `could not read Username for 'https://github.com':
terminal prompts disabled`, which an early probe without `-c credential.interactive=false` also
printed. All unit and integration tests passed — the `file://` test remote fails differently
("does not appear to be a git repository"). Only the manual run of the built CLI against
github.com showed that with `credential.interactive=false` (SPEC-201 §5.1 rule 2) git prints
`fatal: unable to get password from user` instead, so the user saw the vague "git failed: unable
to get password from user".

A second trap in the same work: a "skips submodules" test passed although the fixture had no
submodule — `git add -A` in the fixture helper staged the deletion of the gitlink added with
`update-index --cacheinfo 160000,…`, because its path had no directory in the work tree. Only the
100% coverage gate (the `continue` for mode `160000` was never taken) revealed it.

## Lesson

Every hardening flag can change git's messages. Error classification must be built from stderr
recorded with the exact argv and environment the code uses, against the real service, and a
local stand-in remote does not reproduce a hosted service's errors. A hostile or unusual fixture
must be proven armed, or the test proves nothing.

## How to apply

- When adding or changing a `-c` option or environment variable of hosted git, re-record the
  messages of the failure cases (missing repository, private repository, DNS failure) with the
  real command line and add them to the table in `packages/runner/test/hosted-git.test.ts`.
- Keep the manual check against github.com in the run log of any change to hosted git; tests stay
  offline.
- Assert the fixture first (e.g. `ls-tree` shows `160000 commit`), and commit special index
  entries with `git commit`, not after `git add -A`.
