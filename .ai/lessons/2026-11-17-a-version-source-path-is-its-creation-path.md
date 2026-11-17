---
title: A version's source_path is where it was created, not where the artifact is now
date: 2026-11-17
tags: [database, identity, testing]
source: .ai/runs/2026-11-17-issue-245-nameless-skill-install-name.md
---

# A version's source_path is where it was created, not where the artifact is now

## Context

Issue 245 asked whether to install a nameless skill under "the version's own folder name". The
version stores `artifact_versions.source_path`, but it is written only when the version is
inserted. A skill directory's content hash uses paths relative to the skill root, and a directory
move (FR-103-09) creates no version. After a folder rename, the benchmarked version still named
the old folder. Only `artifact_occurrences.path` follows the rename. While writing tests, two
more scan facts came up. An empty complete scan keeps every occurrence
(`emptyScanKeptOccurrences`), and rule 3 links exact copies only under one name, so nameless
copies in differently named folders stay separate artifacts.

## Lesson

To find where an artifact lives now, read its active occurrences, chosen like
`refreshSourceFields` chooses them. Never read the version's `source_path` for this. It is only
a fallback for artifacts with no active occurrence.

## How to apply

- To get a path or folder for something a user sees "now", use the representative active
  occurrence (highest version number, then oldest `created_at`, then id).
- In scan tests, mark an occurrence removed with a complete scan that finds something else.
- In scan tests, give linked copies the same frontmatter `name`.
- A comparator over random ids must not branch on their order (`Number(a > b) - Number(a < b)`):
  otherwise branch coverage depends on which id the test happened to generate. It failed the macOS
  CI job once (issue 245).
