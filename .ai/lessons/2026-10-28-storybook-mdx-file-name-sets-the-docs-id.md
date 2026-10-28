---
title: An attached MDX page takes its id from its file name unless it matches the CSF file
date: 2026-10-28
tags: [storybook, documentation]
source: .ai/runs/2026-10-28-design-system-storybook.md
---

# An attached MDX page takes its id from its file name unless it matches the CSF file

## Context

The design-system catalogue links to every component page as `?path=/docs/<title>--docs`. The
link to StatusBadge led nowhere: its page was `stories/product/status-badges.mdx`, attached to
`components/status-badge.stories.tsx` with `<Meta of={…} />`, and Storybook indexed it as
`product-benchmarking-statusbadge--status-badges`.

## Lesson

An MDX page attached with `<Meta of>` gets the entry name "Docs" (id `…--docs`) only when its
file name matches the CSF file's name; otherwise the file name becomes the entry name and id.
The directory does not matter.

## How to apply

Name each MDX page after its story file (`button.mdx` for `button.stories.tsx`). After a
build, check the docs ids in `storybook-static/index.json`; the catalogue story test checks the
link format, not that the target exists.
