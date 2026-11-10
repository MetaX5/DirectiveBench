---
title: A label squeezed onto several lines, or a shrunken icon, means the layout does not fit
date: 2026-10-29
tags: [web, css, layout, review]
source: .ai/runs/2026-10-29-fix-artifacts-table-full-hd.md
---

# A label squeezed onto several lines, or a shrunken icon, means the layout does not fit

## Context

Issue 122 made the Artifacts table fit 1920px, but the "Mock agent: not an AI evaluation"
badge still wrapped onto two or three lines and its flask icon was drawn smaller than 12px.
The run and its review called this a pre-existing nit. The maintainer rejected it: the badge
looked broken. The icon was smaller because an `svg` in a flex row shrinks (`flex-shrink: 1`)
when the text next to it wraps, even with `size-3`.

## Lesson

- "Fits" means every label is readable at its natural size. A badge broken over lines, or an
  icon shrunk by flex, is a layout failure to fix in the same change, not a follow-up nit.
- An icon inside a flex badge or button that can wrap needs `shrink-0`.
- To keep a cell's content on one line in an auto-layout table, give the cell content
  `min-w-max`; the column's floor then includes it, so measure the table again.
- `break-all` or `wrap-anywhere` on a table cell drops its minimum width to one character, so
  auto layout squeezes that column to a letter per line at 320px (issue 65, browser QA D1:
  First seen was 68px wide). Pair them with a `min-w-*` floor, as `/artifacts` does, and use
  `wrap-anywhere` rather than `break-all` on sentences so only long tokens break.

## How to apply

When a change is about fitting content, look at every badge and icon in the screenshots at
the target size, and assert in the geometry test that the label has one line box
(`Range.getClientRects().length === 1`) and the icon keeps its size.
