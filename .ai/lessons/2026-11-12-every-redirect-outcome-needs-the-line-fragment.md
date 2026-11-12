---
title: Give every redirect outcome of a page-level line the line's fragment, not only success
date: 2026-11-12
tags: [web, ux, accessibility, playwright]
source: .ai/runs/2026-11-12-repository-removal.md
---

# Give every redirect outcome of a page-level line the line's fragment, not only success

## Context

SPEC-125 Phase 2 (PR #217) put the repository-removal result in a page-level line below the
Register card and gave only the success redirect a `#remove-result` fragment (decision D19).
The browser QA agent confirmed a stale panel at 320×640: the `?removeError=not-found` alert
rendered 50 px below the fold, the panel was gone and focus was on `body`, so the user saw no
feedback at all. The e2e test had only checked the success path in the viewport.

## Lesson

A line that reports a form's outcome is needed most when the outcome is an error. When a
Server Action redirects to a page whose result line can sit below the fold, every outcome
(success, not found, invalid, failed) must carry the line's fragment. In Next 16 a
Server Action `redirect()` to `?query#id` keeps the fragment and scrolls the element into
view, and a `next/link` to `/page#id` also moves the keyboard start point: the next Tab
reached the row's first button (both verified in Chromium).

## How to apply

- Put the fragment on every redirect of an action whose result line is page-level, and assert
  each URL in the action's unit test.
- In Playwright, check `toBeInViewport()` for one error outcome at 320px, not only for success
  (seed the target with `withDatabase` and delete it behind the open panel to get `not-found`).
