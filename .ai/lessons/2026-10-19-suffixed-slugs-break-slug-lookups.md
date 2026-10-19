---
title: Once new artifacts get suffixed slugs, a lookup by the unsuffixed slug no longer finds them
date: 2026-10-19
tags: [database, identity]
source: .ai/runs/2026-10-19-issue-16-scan-local-repository.md
---

# Once new artifacts get suffixed slugs, a lookup by the unsuffixed slug no longer finds them

## Context

Repository scans (issue #16) stopped merging artifacts by slug and give a new artifact the first
free slug (`validate`, `validate-2`, …). Bundled-example import still identifies its artifact by
slug, restricted to the same provider so that it never attaches to a scanned skill. When a scan ran
first, the bundled skill became `validate-2`; the next import, from a new install location,
looked for `validate` among bundled artifacts, found nothing and created `validate-3`. That would
create a new artifact on every install. A test that imports from two locations caught it.

## Lesson

An identity rule that keys on the slug breaks as soon as slugs can be suffixed. Match on something
that does not change with the suffix: the occurrence (repository and path), or the name and type
within the same provider.

## How to apply

- Repository content: identity by occurrence (SPEC-101 §8.3 rule 1), never by slug.
- Bundled examples: `importArtifactVersion` matches the slug, or the name and type, among artifacts
  of the same provider (`packages/database/src/repositories/artifacts.ts`).
- When changing identity rules, test both orders (scan first, then import, and the other way
  round) and a second import from a moved location.
