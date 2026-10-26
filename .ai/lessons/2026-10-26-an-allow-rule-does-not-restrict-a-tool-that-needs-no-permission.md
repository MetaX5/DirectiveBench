---
title: An allow rule does not restrict a tool that needs no permission
date: 2026-10-26
tags: [security, claude-code, live-check]
source: .ai/runs/2026-10-26-issue-103-live-check.md
---

# An allow rule does not restrict a tool that needs no permission

## Context

SPEC-118 FR-118-08 relied on `--allowedTools Skill(<name>)` under `--permission-mode dontAsk` denying every other skill. All unit tests passed, but they used hand-written stream fixtures that assumed the denial. The first real session (`claude` 2.1.302) invoked a second project skill without any denial: in this version the `Skill` tool does not ask for permission, so an allow rule adds nothing and restricts nothing. The same live check showed that a `/<name>` prompt leaves no expansion message in print mode, which a constructed fixture had assumed too.

## Lesson

An allow rule only matters for a tool that would otherwise be asked about or denied. To restrict a tool, use a deny rule, or a setting that turns the target off (`skillOverrides`, `disableBundledSkills`). Where neither is possible without knowing names in advance, detect use and fail closed. Constructed fixtures prove the parser, not the CLI's behaviour.

## How to apply

- For every confinement claim that rests on a CLI's permission rules, add a live-check scenario that tries to break it (another skill, an outside read, an outside create and an outside overwrite), and treat the claim as an assumption until that scenario passes.
- Search the CLI binary's strings for settings (`strings | grep -i <topic>`) before designing around permission rules: `disableBundledSkills`, `skillOverrides` and `autoMemoryEnabled` came from there.
- Prefer detection that makes a result not comparable over an assumed denial.
