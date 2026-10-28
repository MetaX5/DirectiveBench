---
title: A UI change gets an exploratory browser QA agent and a Codex review before it is called done
date: 2026-10-28
tags: [process, web, qa, review]
source: .ai/runs/2026-10-28-artifact-metadata-editing.md
---

# A UI change gets an exploratory browser QA agent and a Codex review before it is called done

## Context

PR #141 (issue #64) passed the full gate, its own Playwright tests and the author's screenshot
review, and was reported as ready. The maintainer asked for a browser agent "because these are
UI changes" and for the Codex review. The browser agent (Claude in Chrome on the built app)
then found a layout overflow and three keyboard-focus losses that no test covered, and Codex
found an unbounded query and two more focus bugs over two rounds.

## Lesson

Scripted tests check what the author thought of. An agent exploring the running UI by
keyboard, at narrow widths, in both themes and with edge-case input finds what the author did
not; the Codex adversarial review finds design and state problems a self-review misses.

## How to apply

For any change to `apps/web` pages or components, before reporting it as ready:

1. Run a browser QA agent (Claude in Chrome or agent-browser) against the built app after
   `directivebench demo`, with a brief listing the flows, invalid input, keyboard-only use,
   both themes, 320px and the console.
2. Run the Codex adversarial review and re-run it after fixing its findings until it
   approves.
3. Turn every confirmed finding into a regression test that fails on the old build.
