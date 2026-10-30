---
title: A view guard on a server page is the last await before the render, and a default selection belongs in the URL
date: 2026-10-30
tags: [web, security, nextjs, server-actions]
source: .ai/runs/2026-10-30-agent-run-output-files-blind-review.md
---

# A view guard on a server page is the last await before the render, and a default selection belongs in the URL

## Context

SPEC-123 Phase 5 (blind review, PR #167) closes every labelled view of a run while its blind
review is unrevealed. Two bugs were found after the gate passed:

- **Codex adversarial review, round 1.** The files and compare pages checked
  `hasUnrevealedBlindReview` once, at the top, and then awaited the database and the syntax
  highlighter. A request that passed the check and waited for highlighting could finish after
  another tab started the review, and still render variant labels and agent-run ids. Codex
  reproduced it by pausing highlighting.
- **The first e2e run.** The review page opened "the first pair without a verdict" when the URL
  had no `?pair=`. Recording a verdict revalidates the route, so the server re-rendered the
  *next* open pair. The verdict panel was a different React element, and its "Verdict recorded."
  line and focus target were lost.

## Lesson

- A guard on shared state that decides what a Server Component may render is check-then-act.
  It has to run again after every await that loads the guarded data, as the last await before
  the elements are returned. A check only at the top of the page is not enough.
- A server-rendered default that depends on mutable state ("the first open item") moves under
  the user when a server action revalidates the page. Client state such as an action result,
  focus or a draft is then attached to the wrong item.

## How to apply

- Wrap the labelled load in one helper that checks before and after it
  (`loadUnlessBlindReview` in `apps/web/lib/blind-review.ts`). Build the page's elements inside
  the load, or return the data from it, and render nothing labelled when it reports `closed`.
  Unit-test a load that flips the state midway.
- When a page picks a default item from mutable state, `redirect()` to a URL that names it
  before any form on the page is used. Test that an action on the default URL keeps its result
  line.
