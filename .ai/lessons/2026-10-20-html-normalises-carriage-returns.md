---
title: The DOM cannot show a carriage return — a raw view is byte-exact only for LF content
date: 2026-10-20
tags: [web, rendering, testing]
source: .ai/runs/2026-10-20-issue-17-browse-artifacts.md
---

# The DOM cannot show a carriage return — a raw view is byte-exact only for LF content

## Context

Issue #17 asks for a raw preview that matches the source file byte for byte. React escapes
`<`, `>`, `&` and quotes, and its server renderer even re-adds the leading newline that the HTML
parser drops after `<pre>`, so leading blank lines, tabs, trailing spaces and non-ASCII text all
survive. Carriage returns do not: the HTML parser turns CR LF and a lone CR into LF before the
text reaches the DOM, so `textContent` of a CRLF file differs from the stored bytes.

## Lesson

A `<pre>` raw view reproduces stored text exactly except for CR characters, which the browser
normalises; the database still holds them. Do not claim byte-for-byte fidelity in the page for
CRLF files, and do not "fix" it by encoding CR in the text (that changes what is shown).

## How to apply

- Say so in the UI: the Content tab shows `rawViewNotice` when the file contains `\r`.
- Byte-for-byte e2e checks compare `Buffer.from(textContent, 'utf8')` with the file read from disk
  and use LF fixtures; cover leading newlines, tabs and non-ASCII text, which do round-trip.
- If exact bytes are ever needed in the browser (copy/download), serve them from a dedicated
  `text/plain` response with `X-Content-Type-Options: nosniff`, not from the DOM.
