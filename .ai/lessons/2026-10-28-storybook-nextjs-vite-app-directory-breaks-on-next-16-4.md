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

Do not set `nextjs.appDirectory`, globally or per story: per story it fails the same way
(checked in stage 3). For a component that calls `usePathname` or `useRouter`, stub the hook
in the story's `beforeEach` with the framework's spies:
`import { usePathname } from '@storybook/nextjs-vite/navigation.mock'` and
`usePathname.mockReturnValue('/artifacts')` (see `components/nav.stories.tsx`).
