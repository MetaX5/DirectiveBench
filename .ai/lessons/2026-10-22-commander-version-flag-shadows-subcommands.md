---
title: A subcommand option named --version is taken by the program's -V/--version
date: 2026-10-22
tags: [cli, commander]
source: .ai/runs/2026-10-22-issue-97-benchmark-cli.md
---

# A subcommand option named --version is taken by the program's -V/--version

## Context

SPEC-118 FR-118-30 named the artifact version flag of `benchmark run` `--version <n>`. With
`program.version(…, '-V, --version')`, `directivebench benchmark run ./suite --artifact x
--version 2` printed the package version and exited 0 instead of running the benchmark.

## Lesson

Commander recognises program options anywhere on the line unless positional options are enabled,
and enabling them breaks `--data-dir` (and the serve options) given after a subcommand, which the
CLI supports. So `--version` (and `-V`, `-h`, `--help`) cannot be subcommand options here.

## How to apply

Do not name a subcommand option after a program option; `benchmark run` uses `--artifact-version`.
When a spec names such a flag, change the spec in the same change set. Check a new flag with the
built CLI (`node apps/cli/dist/cli.js <subcommand> … --flag value`), not only with mocked
command handlers.
