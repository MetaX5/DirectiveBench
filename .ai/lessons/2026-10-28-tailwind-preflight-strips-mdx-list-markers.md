---
title: Loading globals.css in Storybook strips list markers and theme variables from docs
date: 2026-10-28
tags: [storybook, tailwind, documentation]
source: .ai/runs/2026-10-28-design-system-storybook.md
---

# Loading globals.css in Storybook strips list markers and theme variables from docs

## Context

The Foundations MDX pages load `app/globals.css` so stories render with the real tokens.
Numbered rules in MDX then rendered without numbers: Tailwind's preflight sets
`list-style: none` on every `ol` and `ul`, and Storybook's MDX lists carry no class. Token
previews also showed nothing for `--text-ui--line-height`: Tailwind 4 emits a theme variable
only when a utility uses it.

## Lesson

Two Tailwind 4 behaviours leak into documentation: preflight resets elements that the docs
renderer leaves unclassed, and `@theme` variables exist at runtime only if a utility uses them.

## How to apply

Restore documentation styles in `.storybook/preview.css` with selectors limited to MDX output
(`.sbdocs-content > ol`), never to stories. Preview type tokens through their utility classes
(`text-ui`), not through `var(--text-ui--line-height)`, and assert in the story test that a
preview is not empty.
