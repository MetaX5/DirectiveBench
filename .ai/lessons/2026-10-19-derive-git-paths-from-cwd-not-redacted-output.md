---
title: Never store a value parsed from redacted command output; inspect git with the path as cwd and --show-cdup
date: 2026-10-19
tags: [git, security, repository-registration]
source: .ai/runs/2026-10-19-issue-15-register-local-repository.md
---

# Never store a value parsed from redacted command output; inspect git with the path as cwd and --show-cdup

## Context

Registering a local repository (issue #15) needs the work tree's top-level directory. The obvious
`git rev-parse --show-toplevel` prints an absolute path, but the runner runs git through
`runCommand` (`@directivebench/benchmark-engine`), which passes stdout and stderr through
`redactSecrets`. A directory whose name looks like a token (for example `ghp_…`) would come back as
`[REDACTED…]` and be stored as the repository location. Passing the user's path as an argument
(`git -C <path>`) would also let a path that starts with `-` reach git's option parser.

While testing, two more git facts turned up:

- `git rev-parse --is-inside-work-tree` run inside `.git` (or a bare repository) prints `false`
  and exits 0; outside any repository it exits 128 with "not a git repository".
- `git rev-parse` and `git symbolic-ref` never run hooks or fsmonitor, but `git status` does run a
  repository's `core.fsmonitor` command and `post-index-change` hook. `-c core.fsmonitor=false
  -c core.hooksPath=/dev/null` (command-line config wins over `.git/config`) stops both.

## Lesson

Output that went through redaction is for display, not for data: never parse a stored identifier
(path, branch used as a key, commit) from it. Ask git questions whose answers carry no user data,
and pass user paths as the working directory, not as arguments.

## How to apply

- Run git with `cwd` set to the canonical (`realpath`) path and derive the top level from
  `rev-parse --show-cdup` (only `../` segments; reject anything else) joined to that path — see
  `packages/runner/src/repository-registration.ts`.
- Treat `--is-inside-work-tree` = `false` as "inside a git directory", and only the
  "not a git repository" message (with `LC_ALL=C`) as "plain directory"; fail closed on anything
  else.
- To prove a hardening flag works, first prove the fixture is armed (an unhardened `git status`
  writes the marker), then run the hardened command and assert no marker and an unchanged file
  snapshot.
