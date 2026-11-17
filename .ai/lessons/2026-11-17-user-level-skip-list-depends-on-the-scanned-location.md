---
title: The user-level skip list depends on the scanned location
date: 2026-11-17
tags: [scan, d05, repositories]
source: .ai/runs/2026-11-17-issue-244-overlap-user-level-folder.md
---

# The user-level skip list depends on the scanned location

## Context

Issue 244 made the FR-104-18 overlap confirmation say that a nested user-level agent folder is
skipped, so nothing is counted twice and "a scan of it finds no artifacts". The first version
derived the second claim from the outer repository's skip list. The Codex adversarial review of
PR #261 found the gap: `userLevelAgentFolders(home, env, location)` adds the sibling homes'
folders (`/home/bob/.claude`) only when `location` contains the home directory. With `/home`
registered, `/home/bob/.claude` is skipped by the `/home` scan but read by its own scan (verified
on the built app: 1 artifact found).

## Lesson

"Skipped by the scan of X" does not imply "skipped by the scan of Y" for a different location:
the skip list is computed per scanned location. Any claim about what a scan of a location reads
must be computed with that location as the scanned one.

## How to apply

- When wording or logic depends on what a scan skips, call `userLevelAgentFolders` with the
  location whose scan the sentence talks about, and test a sibling-home case (home
  `<root>/users/alice`, folder `<root>/users/bob/.claude`, `<root>/users` registered).
