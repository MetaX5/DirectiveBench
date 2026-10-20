---
title: getByLabel matches substrings, and a wrapping label's name includes its select's options
date: 2026-10-20
tags: [testing, playwright]
source: .ai/runs/2026-10-20-issue-17-browse-artifacts.md
---

# getByLabel matches substrings, and a wrapping label's name includes its select's options

## Context

On the Artifacts filter form each `<select>` sits inside its `<label>`. In Playwright,
`page.getByLabel('Type')` failed with a strict-mode violation: it resolved to the Type select
**and** the Category select, whose accessible name was "CategoryAllArchitectureBackend…" — the
label text plus every option text — and contained "Type" somewhere in a category name.

## Lesson

`getByLabel` (like `getByRole({ name })`) matches a case-insensitive substring by default, and a
label that wraps a `<select>` gets the option texts in its computed name. Short label texts such
as "Type" collide with other fields as soon as option lists grow (e.g. with registered data).

## How to apply

Address filter selects by their `name` attribute (`page.locator('select[name="type"]')`) or by an
anchored role name (`getByRole('combobox', { name: /^Type/ })`); use `exact: true` only when the
label does not wrap the control.
