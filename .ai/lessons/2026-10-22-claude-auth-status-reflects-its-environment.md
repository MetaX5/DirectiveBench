---
title: "`claude auth status` describes the environment it runs in — probe it with the agent's environment, not the caller's"
date: 2026-10-22
tags: [claude-code, security, agents]
source: .ai/runs/2026-10-22-issue-102-claude-code-readiness.md
---

# `claude auth status` describes the environment it runs in — probe it with the agent's environment, not the caller's

## Context

While implementing Claude Code readiness (issue #102) the real `claude` 2.1.302 was run
read-only with an empty `HOME`/`CLAUDE_CONFIG_DIR`. Without a key it printed
`{"loggedIn": false, "authMethod": "none", …}` and exited 1; with a dummy `ANTHROPIC_API_KEY`
in its environment it printed `"loggedIn": true, "authMethod": "api_key"` and exited 0. The
logged-in output of a subscription login also carries the account's email, organisation id and
name, and the command creates the configuration directory when it is missing.

## Lesson

"Logged in" is a property of the CLI's whole environment, not of the subscription login: a
stray `ANTHROPIC_API_KEY` (or `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_*`, an `apiKeyHelper` in a
project's `.claude/settings.json`) changes the answer. A readiness check that inherits the
caller's environment or working directory reports a mode the agent run will not use. The output
is also personal data, so it must never be stored, logged or shown.

## How to apply

Run status probes with the same environment rules as the agent process of that mode (allowlist,
no `ANTHROPIC_*`/`CLAUDE_CODE_*`/`CLAUDE_CONFIG_DIR` for subscription mode) and in an empty
temporary working directory (`runProbe` in `packages/agent-adapters/src/probe.ts`). Parse only the
fields you need (`loggedIn`, `authMethod`), require exit 0 as well, fail closed on anything else,
and test with a fake `claude` that records its environment and prints planted personal fields.
Check API-key mode by presence only, never by echoing or validating the key.
