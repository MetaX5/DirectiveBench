---
title: Enforce an invariant on every exit path, not on the path a review reported
date: 2026-10-22
tags: [security, review, engine]
source: .ai/runs/2026-10-22-issue-101-process-control.md
---

# Enforce an invariant on every exit path, not on the path a review reported

## Context

PR #109 pins the run workspace before untrusted code runs. Codex rounds 2–5 each found one more
place where a replaced workspace was not detected: between setup commands, after command
assertions, after failed agent runs, after a throwing adapter. Each fix covered only the reported
path, so the next round found the neighbouring one. PR #111 showed the same pattern with secret
redaction (one raw-text path per round) until redaction moved to a single place that covers every
path (known secrets matched in their JSON-escaped forms).

## Lesson

When a review finds an invariant broken on one path, the bug is the missing enforcement point,
not the path. List every way control leaves the guarded region — each step that runs untrusted
code, every status, `catch` and early `return` — and enforce the invariant at a single choke point
or at all of them in the same change.

## How to apply

- Before fixing a security or integrity finding, enumerate the exits of the function or loop
  (normal, each status branch, thrown errors) and write one regression per exit class.
- Prefer one choke point: a `catch`/`finally` check, a wrapper around every untrusted step, or a
  transform applied to all output (as with redaction in the stream parser).
- In the PR, say which exits are covered, so the next review checks the claim rather than finding
  the next path.
