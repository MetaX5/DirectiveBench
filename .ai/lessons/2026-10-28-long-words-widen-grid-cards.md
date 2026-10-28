---
title: break-words does not stop a long word from widening a grid card; use wrap-anywhere
date: 2026-10-28
tags: [web, css, layout]
source: .ai/runs/2026-10-28-artifact-metadata-editing.md
---

# break-words does not stop a long word from widening a grid card; use wrap-anywhere

## Context

The browser QA of issue #64 added a 64-character tag without spaces. The Tags card grew past a
360px screen and its Remove button left the card, although the status line had `break-words`
and the Badge has `max-w-full whitespace-normal`.

## Lesson

- A grid or flex item has `min-width: auto`, so it is at least as wide as its min-content.
  `overflow-wrap: break-word` (`break-words`) breaks a long word only after layout and does
  not lower min-content; `overflow-wrap: anywhere` (`wrap-anywhere`) and `break-all` do.
- `Badge` is `shrink-0`: next to a button in a flex row it keeps its full width and pushes the
  button out. Give it `min-w-0 shrink break-all` where it holds user text.

## How to apply

Wherever user text without spaces can appear in a card (tags, names, messages that repeat
them), use `wrap-anywhere` or `break-all`, and test it at 320 to 360px with a long unbroken
value: assert no horizontal scroll and that the row's button stays inside the card.
