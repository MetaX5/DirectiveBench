---
title: A "nothing changes on refusal" guarantee covers the data directory, so test it fresh and outdated
date: 2026-10-22
tags: [cli, database, testing, consent]
source: .ai/runs/2026-10-22-issue-97-benchmark-cli.md
---

# A "nothing changes on refusal" guarantee covers the data directory, so test it fresh and outdated

## Context

`benchmark run` promised that every refusal before its final transaction leaves the database
unchanged (SPEC-118 FR-118-39), and the refusal tests compared row counts of the benchmark
tables. But the command started with `initialize()`, the same helper as `init` and `serve`: a
fresh `--data-dir` got a database, migrations and seeded categories before an unknown artifact
was refused, and an older database was migrated before a declined confirmation. The tests all
started from an already initialised, current database and counted only the tables the run
writes, so they could not see it (Codex adversarial review round 1 of PR #118). The same review
found readiness accepting an API key (`abc`) that `buildClaudeEnv` always refuses: two checks of
one rule drifted apart.

## Lesson

A consent or refusal guarantee is about the whole data directory, not the rows the happy path
writes. Commands that refuse or ask before acting read an initialised, fully migrated database
read-only (`openInitializedDatabase` in `apps/cli/src/setup.ts`) and call `initialize()` only
after the user agreed. A precondition checked in two places (readiness and execution) is one
shared function, never two copies.

## How to apply

- For a command with a refusal or confirmation path, test it against a **missing** data
  directory (assert it is not created) and an **older** database (migrate with a journal prefix,
  assert migration and category counts are unchanged), not only against a current one.
- When readiness/preflight and execution check the same input, export one function
  (e.g. `claudeApiKeyIssue`) and call it from both, with a test that the preflight refuses
  every value the execution path refuses.
