---
title: Never store a value parsed from redacted command output; inspect git with the path as cwd, an absolute git and a checked top level
date: 2026-10-19
tags: [git, security, repository-registration]
source: .ai/runs/2026-10-19-issue-15-register-local-repository.md
---

# Never store a value parsed from redacted command output; inspect git with the path as cwd, an absolute git and a checked top level

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

The independent review (PR #42) found two more traps of the "path as cwd" design:

- `spawn('git', …, { cwd })` resolves the bare name *after* entering `cwd` when `PATH` has an empty
  or `.` entry (POSIX), and libuv on Windows searches the child's cwd before `PATH`. A `git`
  committed at the repository root then runs — no `.git/config` trick needed.
- A repository's `core.worktree` (or a `gitdir:` file pointing at such a config) makes
  `--show-cdup` answer `../../..` up to `/`, so git's answer alone can move the stored location.

## Lesson

Output that went through redaction is for display, not for data: never parse a stored identifier
(path, branch used as a key, commit) from it. Ask git questions whose answers carry no user data,
and pass user paths as the working directory, not as arguments.

## How to apply

- Run git with `cwd` set to the canonical (`realpath`) path and derive the top level from
  `rev-parse --show-cdup` (only `../` segments; reject anything else) joined to that path — see
  `packages/runner/src/repository-registration.ts`.
- Resolve the executable to an absolute path in the parent (absolute `PATH` entries only) before
  spawning anything with an untrusted `cwd`, and drop relative entries from the child's `PATH`.
- Cross-check git's top level against the nearest `.git` entry at or above the path.
- Treat `--is-inside-work-tree` = `false` as "inside a git directory", and only git's discovery
  message "not a git repository (or any" (with `LC_ALL=C`) as "plain directory" — a broken `.git`
  file prints "not a git repository: <path>"; fail closed on anything else.
- To prove a hardening flag works, first prove the fixture is armed (an unhardened `git status`
  writes the marker), then run the hardened command and assert no marker and an unchanged file
  snapshot.
