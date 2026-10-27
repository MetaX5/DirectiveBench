---
title: Register custom Tailwind theme tokens with tailwind-merge
date: 2026-10-27
tags: [ui, tailwind, build]
source: .ai/runs/2026-10-27-design-tokens.md
---

# Register custom Tailwind theme tokens with tailwind-merge

## Context

SPEC-120 added font-size tokens (`--text-caption`, `--text-metric`, …) and named spacing,
radius and container values to `globals.css`. Tailwind generated the utilities, but `cn()`
(tailwind-merge) did not know them: `cn('text-caption text-muted-foreground')` returned only
`text-muted-foreground`, because an unknown `text-*` value is classified as a text colour.
Spacing tokens were not dropped but also did not replace their defaults (`cn('h-8',
'h-control')` kept both).

## Lesson

tailwind-merge validates values against Tailwind's default scales only. A custom theme value
passes `@theme` and the build without warning, and the class silently disappears or fails to
override once it goes through `cn()` next to a conflicting class.

## How to apply

When adding a `--text-*`, `--spacing-*`, `--radius-*` or `--container-*` value to `@theme`,
add its name to `extendTailwindMerge` in `apps/web/lib/utils.ts` and a case to
`test/utils.test.ts`. Colours need nothing: unknown colour names already fall into the colour
group.
