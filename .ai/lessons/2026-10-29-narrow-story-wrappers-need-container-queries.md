---
title: A component that must stack in a narrow column needs a container query, not a viewport breakpoint
date: 2026-10-29
tags: [web, storybook, responsive, testing]
source: .ai/runs/2026-10-29-spec-123-design-system-components.md
---

# A component that must stack in a narrow column needs a container query, not a viewport breakpoint

## Context

`SideBySideDiff` first used `md:grid-cols-2`. Its 320px story wraps the component in
`max-w-80`, as every narrow-screen story does, but the Storybook test browser's viewport is
wide, so `md:` still applied: both columns stayed side by side inside 320px and the
"columns stack, left first" play function failed (`expected 148 to be less than 148`).

## Lesson

A `max-w-80` story wrapper narrows the component, not the viewport. Viewport breakpoints
(`md:`, `lg:`) never fire in it, and the same component placed in a narrow page column would not
stack either. A layout that depends on the space the component gets needs a container query.

## How to apply

Put `@container` on the component's root and use container variants (`@3xl:grid-cols-2`,
48rem of the component's own width). Assert the stacking in the narrow story's play function
(compare the two columns' `top`), so a regression to a viewport breakpoint fails
`pnpm test:storybook`.
