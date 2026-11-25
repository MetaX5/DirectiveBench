---
title: Browser QA downloads go to a folder under .ai/tmp/, never the user's ~/Downloads
date: 2026-11-19
tags: [qa, browser, cleanup]
source: .ai/runs/2026-11-19-issue-52-content-exact-bytes.md
---

# Browser QA downloads go to a folder under .ai/tmp/, never the user's ~/Downloads

## Context

Issue #52 added a Download link to the Content tab. The exploratory browser QA agent drove the
user's own Chrome (chrome-devtools MCP) and opened the file route of a fixture `evil.html`
(`<script>alert(1)</script>`) directly. Chrome saved it to the user's `~/Downloads`; the user
found it and the maintainer corrected the run. The QA agent had reported "no file appeared in
~/Downloads", so its own check was not reliable.

## Lesson

Any browser test that can trigger a download (a link with `download`, a `Content-Disposition:
attachment` response, a route opened directly) writes into the browser's download directory,
which for a real browser profile is the user's `~/Downloads`. That is a file left on the user's
machine, possibly hostile fixture content.

## How to apply

- Playwright: downloads go to its own temporary directory; keep `TMPDIR` on disk and save with
  `download.saveAs(...)` into `.ai/tmp/` only when a file must be kept.
- A QA agent in a real browser sets the download directory first (CDP
  `Browser.setDownloadBehavior` with `behavior: "allow"` and a `downloadPath` under `.ai/tmp/`,
  or the agent-browser download path), or checks bytes with `fetch()` instead of clicking.
- The brief says so, and the agent lists every file it downloaded and where; the owner deletes
  them before finishing and checks `~/Downloads` itself.
