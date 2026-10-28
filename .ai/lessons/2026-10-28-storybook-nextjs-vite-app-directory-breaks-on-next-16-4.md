---
title: Storybook's appDirectory mock breaks every story on Next 16.4
date: 2026-10-28
tags: [storybook, nextjs, testing]
source: .ai/runs/2026-10-28-design-system-storybook.md
---

# Storybook's appDirectory mock breaks every story on Next 16.4

## Context

With `@storybook/nextjs-vite` 10.6.2 and Next 16.4.2, setting `parameters.nextjs.appDirectory:
true` in `.storybook/preview.tsx` made every story fail to render with "Cannot read properties
of undefined (reading 'data')" thrown from `useRouter` inside Next's `RedirectBoundary`. The
stack points into Next, not into the story, so it looks like a broken component.

## Lesson

The App Router mock of Storybook 10.6.2 does not match the router context of Next 16.4. Set as
a global parameter it breaks all stories, including ones that never touch the router.

## How to apply

Do not set `nextjs.appDirectory` globally. When a component needs `usePathname` or
`useRouter` (`Nav`, `AutoRefresh`), set it on that story only and check that it renders; if it
still throws, mock `next/navigation` for that story instead, and record the result here.
