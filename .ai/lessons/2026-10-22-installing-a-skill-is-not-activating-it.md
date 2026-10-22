---
title: Installing a Claude Code skill neither activates it nor makes it inert
date: 2026-10-22
tags: [claude-code, benchmarks, security, specs]
source: .ai/runs/2026-10-22-benchmark-own-skills-s1-spec.md
---

# Installing a Claude Code skill neither activates it nor makes it inert

## Context

The first SPEC-118 draft wrote the candidate skill to `.claude/skills/<slug>/` and ran
`claude -p` with `--tools "Read,Edit,Write,Glob,Grep"`. A Codex review (PR #92, round 1) found
two consequences, both confirmed in the Claude Code docs on 2026-10-22: `Skill` is a built-in,
permission-gated tool (tools reference), so that tool list made the installed skill impossible to
invoke and every candidate run would have measured "no skill"; and a skill can run code without
the `Bash` tool — frontmatter `hooks` on invocation, `` !`command` `` placeholders before the model
sees the skill, and `allowed-tools` grants — even in an untrusted `-p` run (skills, hooks docs).
The same review found that a regex validated only for syntax (`(a+)+$`) blocks the event loop
for seconds to minutes.

## Lesson

A skill's body enters the conversation only when the `Skill` tool runs it, and a skill is code as
much as text. Measuring a skill needs both the tool and evidence from the trace that it ran;
installing an untrusted skill needs the same inspection as any other executable input.

## How to apply

- When a run's tool list is restricted, check every artifact type still has its activation path
  (`Skill` for skills; instruction files load without it) and record activation from the trace.
- Treat SKILL.md frontmatter `hooks`, `allowed-tools`, `` !` `` placeholders and bundled plugin,
  MCP or settings files as executable; inspect candidate **and** baseline versions.
- Never evaluate a user-supplied regular expression on the runner's event loop; bound it with a
  terminable worker and a named deadline (SPEC-118 FR-118-46).
- Prove agent-harness assumptions with an opt-in live check that uses the exact production argv.
