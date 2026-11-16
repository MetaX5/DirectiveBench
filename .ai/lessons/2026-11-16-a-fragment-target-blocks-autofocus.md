---
title: A URL fragment that names an element stops the browser's autofocus on page load
date: 2026-11-16
tags: [web, accessibility, focus, testing]
source: .ai/runs/2026-11-16-issue-58-choose-branch.md
---

# A URL fragment that names an element stops the browser's autofocus on page load

## Context

Issue 58: Change branch is a GET form (`/repositories?changeBranch=<id>`) that opens a panel with
an `autoFocus` Branch field. With the form's action `/repositories#branch-panel`, a real browser
left focus on the panel (it had `tabIndex={-1}`, so the fragment focused it) and, after removing
the tabindex, on `<body>`: the server HTML carried `autofocus`, but the field was never focused.
The HTML standard skips the autofocus candidates of a document whose target element (the
fragment) is not null. Unit tests and Storybook (no fragment) could not see it; a scripted
keyboard flow on the built app did.

## Lesson

On a full page load, `autofocus` (and React's `autoFocus` rendered on the server) does nothing
when the URL fragment names an element; a focusable fragment target takes focus instead. A
client-side navigation (a server action's `redirect`) mounts the element and React calls
`focus()` itself, so the same markup can work after one navigation and fail after another.

## How to apply

- A link or GET form that opens something whose field must take focus does not carry a fragment;
  focusing the field scrolls it into view anyway.
- Keep `#fragment` for result lines that should be scrolled to, and do not give a panel that
  holds an autofocused field `tabIndex={-1}`.
- Assert the focused element in Playwright after every way of reaching the state (full page load
  and post-action redirect).
