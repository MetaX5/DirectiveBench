---
title: A truncated table cell keeps its max width as a floor; measure the table before narrowing columns
date: 2026-10-29
tags: [web, css, layout, tables]
source: .ai/runs/2026-10-29-fix-artifacts-table-full-hd.md
---

# A truncated table cell keeps its max width as a floor; measure the table before narrowing columns

## Context

Issue 122: the Artifacts table overflowed a 1920px screen by 78px (108 to 140px with long
values). The Description cell had `max-w-xs truncate`, so narrowing it looked like the fix.
Measured in the browser, the other ten columns already sat at their minimum: headers are one
line (`whitespace-nowrap`), so ~814px was a floor. Description had to drop to 12rem to fit,
with 0px to spare and the category and mock badges squeezed. The fix was a wider `main` for
that page only (`data-layout="wide"` → `max-w-wide`).

Also: a comment containing `#122` failed the design-token guard's hex-colour rule
(`#[0-9a-fA-F]{3}\b`). Write "issue 122" in `apps/web` source comments.

## Lesson

- With `table-layout: auto`, a `truncate` (nowrap) cell with `max-w-*` and longer text takes that
  max width as its minimum, and one-line headers set a floor for every other column. Shrinking
  one column gains only what is above the others' floors.
- `scrollWidth - clientWidth` of `[data-slot="table-container"]` and per-header widths, read
  with Playwright after editing the row DOM to worst-case values, answer "which change fits"
  in one run before any code change.

## How to apply

Before fixing a table overflow, measure header widths and the container's overflow at the
target viewport with worst-case content, and compare the options by numbers. Prefer the
page-level `data-layout="wide"` opt-in for wide tables over squeezing columns, and keep
`apps/web/e2e/artifacts-full-hd.spec.ts` as the pattern for a geometry regression test.
