---
title: A server action's redirect re-mounts the page, and Next.js never moves focus
date: 2026-11-17
tags: [web, accessibility, focus, nextjs, testing]
source: .ai/runs/2026-11-17-issue-243-repositories-focus-after-submit.md
---

# A server action's redirect re-mounts the page, and Next.js never moves focus

## Context

Issue 243: on `/repositories` focus dropped to `<body>` after every form submit, even Scan, whose
button is still in the row afterwards. Each action `redirect`s to `/repositories?<new params>`;
the App Router keys the page segment by its search params, so the whole page re-mounts and the
focused element is a removed node. A `#fragment` in the redirect only scrolls
(`layout-router.js`: "This handler intentionally leaves focus untouched"). A job's result that
arrives later by `AutoRefresh` (`router.refresh()`, same URL) does not re-mount, but it removes
the focused status line or re-enables a field, and `autoFocus` changing on an already mounted
input does nothing.

## Lesson

After a server action's redirect to new search params nothing on the page keeps focus, and
React's `autoFocus` helps only form controls (`input`, `button`, `select`, `textarea`) that are
newly mounted: it never focuses a `<p>` or a panel, and never fires on a re-render. A result
line or panel that should take focus needs an explicit `focus()` after it appears.

## How to apply

- Give the target an id and `tabIndex={-1}`, and render a small client effect next to it that
  focuses it when it appears (and when its state changes, if the control that had focus can
  disappear later), only while `document.activeElement` is the body, so focus the user moved
  stays (`app/repositories/take-focus.tsx`).
- Assert focus in Playwright after the redirect and after the re-render that brings the job's
  result, with the keyboard only; a passing check after one is no proof for the other.
