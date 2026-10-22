---
title: A bundled CLI carries its own stream schema — read it as strings before guessing field names
date: 2026-10-22
tags: [claude-code, parsing, evidence, security]
source: .ai/runs/2026-10-22-issue-100-stream-parser.md
---

# A bundled CLI carries its own stream schema — read it as strings before guessing field names

## Context

Issue #100 needed a parser for `claude -p --output-format stream-json` without starting a real
session (no paid call, no credentials). SPEC-118 marked several field names as assumptions
(the init auth source, the skills list, the `Skill` tool input). The installed `claude` 2.1.302
is a single bundled executable whose JavaScript includes the Zod schemas of every stream
message, with descriptions: `strings -n 20 $(readlink -f $(which claude))` and a search for
`subtype:A("init")`, `apiKeySource`, `skill:o()` or `forked-command-` showed the init fields
(`model`, `tools`, `skills`, `apiKeySource` with its enum and meaning), the assistant `error`
categories, `{ skill, args? }` and `forked-command-<name>`. `grep -o '.{0,200}…'` on the binary
failed ("exceeds complexity limits"); extracting strings first and searching them in Python
worked. A second finding: names in that stream (model, `apiKeySource`, error categories) are as
untrusted as message texts and flow into warnings and the comparability key, so they need a
length bound too.

## Lesson

Before coding against an "Assumption — requires validation" field of a bundled CLI, read the
schema shipped in the binary — read-only, no session, no credential — and record it as evidence
(SPEC-203 L3). It confirms names and enums, not runtime behaviour: which messages print mode
actually emits still needs the live check. Every string taken from untrusted output, including
short identifiers, gets a named length bound before it is stored or hashed.

## How to apply

- `LC_ALL=C strings -n 20 <binary> | grep -E '<names>' > scratch.txt`, then print context with
  Python (`-I`); never run the binary beyond `--version`/`--help` for this.
- Label what was read as an evidence row (source, version, date) and keep runtime behaviour as an
  assumption until a live check records it.
- Clip every name from untrusted output with a named limit (`CLAUDE_STREAM_NAME_MAX_CHARS`), and
  test the bound for each place the name is kept.
- (Updated after the Codex review of PR #111.) Redact the whole text before cutting it, never a
  window: core's private-key redactor needs both markers, so a block whose END lies past the
  window — or a key split across events — leaked. Fail closed on fragments (replace anything after
  a BEGIN or before an END marker). Every identifier kept as state (call ids in a pending map), not
  only what goes to the trace, needs a named limit, and arbitrary JSON must not reach recursive
  `JSON.stringify` without a depth check.
