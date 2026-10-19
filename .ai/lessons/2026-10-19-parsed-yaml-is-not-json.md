---
title: Parsed YAML is not JSON — check it before it reaches a JSON column
date: 2026-10-19
tags: [parsing, database, security]
source: .ai/runs/2026-10-19-pr-44-third-codex-review.md
---

# Parsed YAML is not JSON — check it before it reaches a JSON column

## Context

The third Codex review of PR #44 found that a `SKILL.md` with `metadata: &a {self: *a}` failed
every scan of its repository. `yaml`'s `parse` turns a self-referring alias into a circular
object; `parseFrontmatter` returned it as valid frontmatter, and Drizzle's JSON column threw
"Converting circular structure to JSON" inside the single scan transaction. The whole scan rolled
back, every retry failed the same way, and the UI only said "unknown error".

## Lesson

A value that parsed successfully is not necessarily storable. YAML can produce what JSON cannot
represent or silently rewrites: circular objects (aliases), `.inf`/`.nan` (→ `null`), and tagged
values — `!!binary` (`Buffer`), `!!set` (`Set` → `{}`), `!!omap` (`Map` → `{}`), `!!timestamp`
(`Date` → string). `JSON.stringify` throws on the first and loses the rest. A node shared by two
aliases (not circular) is fine. One bad artifact inside a single transaction poisons every other
artifact of that scan.

## How to apply

- Validate untrusted parsed data at the parser (`packages/core`), not at the database: walk it and
  allow only `null`, strings, booleans, finite numbers, arrays and plain objects, tracking
  ancestors for cycles. Treat anything else as invalid input with a warning, so the artifact is
  still discovered and the others are unaffected.
- Pin library resource limits as named constants (`MAX_FRONTMATTER_ALIAS_COUNT` passed as
  `maxAliasCount`), so an upgrade cannot loosen them.
- When a loop of writes runs inside one transaction, wrap each item's failure with its identity
  (`ArtifactStoreError` with the repository-relative path), so the error says which item failed
  without quoting its contents.
- Test with a hostile item next to a valid one, and assert both are stored.
