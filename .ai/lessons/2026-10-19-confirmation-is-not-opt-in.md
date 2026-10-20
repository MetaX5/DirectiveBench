---
title: An unrelated confirmation is not an opt-in to an off-by-default product decision
date: 2026-10-19
tags: [product, security, scanning]
source: .ai/runs/2026-10-19-pr-44-review-fixes.md
---

# An unrelated confirmation is not an opt-in to an off-by-default product decision

## Context

Issue #16 added a confirmation before registering the home directory (FR-104-18). The
implementation then treated that confirmation as the user's opt-in to scanning user-level skill
folders such as `~/.claude/skills`, and the confirmation text said they would be included. Product
decision D05 says user-level folders are an opt-in option, off by default, and out of Now. The
maintainer rejected the interpretation on 2026-10-19: a scan must always skip them.

## Lesson

A confirmation answers the question it asks. "Register this broad directory anyway?" is about scan
size and double counting, not about a feature that a product decision keeps off by default.
Turning one answer into consent for something else reinterprets the decision instead of honouring
it.

## How to apply

- When an implementation touches an off-by-default or out-of-scope item from the product brief
  (`.ai/specs/product-brief.md` decisions), keep it off and say so in the UI copy; do not derive
  consent from a nearby confirmation.
- If a decision seems to need an exception, implement the conservative behaviour and list the
  exception under "Decision needed" in the PR, with the default being the decision as written.
- User-level agent folders are skipped by `userLevelAgentFolders` in
  `packages/runner/src/repository-scan.ts` and `discoverArtifacts({ skipDirectories })`; keep that
  list in step with the integration specs (SPEC-203/204/205) when an agent adds a folder.
