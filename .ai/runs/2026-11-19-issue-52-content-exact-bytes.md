---
title: Issue 52, download or copy a file's exact bytes from the Content tab
date: 2026-11-19
agent: Claude Code / claude-opus-5-5
trigger: issue #52 (om-auto-fix-issue, feature route; spec SPEC-101 FR-101-15)
status: completed
branch: feat/issue-52-content-exact-bytes
specs: [SPEC-101, SPEC-007, SPEC-008]
---

# Run: Issue 52, download or copy a file's exact bytes from the Content tab

## Objective

The Content tab's raw view cannot show CR characters (lesson 2026-10-20). Issue #52 asks for a
download and a copy of a stored file whose bytes equal the stored content exactly (CRLF kept),
the download served with a non-executable content type and `Content-Disposition: attachment`,
and a Playwright test that checks a CRLF fixture byte for byte.

## Plan

1. Spec first: SPEC-101 §10 (route), §11 (Content tab), §12 (headers), acceptance criterion.
2. `apps/web/lib/artifact-download.ts`: strict selection (no fallback: an unknown version or
   file is a 404, a malformed parameter a 400) and the response with `text/plain; charset=utf-8`,
   `attachment` with an ASCII and an RFC 5987 file name, `nosniff`, a sandboxing CSP and
   `no-store`. 100% unit coverage.
3. Thin route handler `apps/web/app/artifacts/[id]/file/route.ts` (reads through
   `getArtifactDetail`, nothing else).
4. Content tab: "Download" (Button-styled link) and "Copy" (client button copying the stored
   string, a `role="status"` result line) in the Raw card; the CR notice names them.
5. Playwright: CRLF fixture, the download and the clipboard byte for byte, headers, 404/400.
6. Story for the copy button; quality gate; browser QA; review loop.

## Decisions

- Route `GET /artifacts/[id]/file?version=&path=` next to the page (not `/api`), served as
  `text/plain; charset=utf-8` whatever the extension (lesson 2026-10-20 suggested it; the issue
  asks for a non-executable type), plus `nosniff`, `sandbox; default-src 'none'` and
  `no-store`. No fallback, unlike the Content tab: an unknown version or path is a 404.
- Copy writes the string the server passed as a prop, not the DOM text. It duplicates the file in
  the RSC payload; files are bounded by the discovery limits, so this is accepted.
- A first draft had a "not valid UTF-8" notice. Discovery already refuses invalid UTF-8 as binary
  (FR-102-17, `isBinary`), so the notice could never show for scanned files (QA finding 1); it was
  removed instead of kept as speculative code.
- Codex is not installed on this machine, so the Codex adversarial review could not run; the
  review is `om-auto-review-pr`.

## Work performed

1. SPEC-101 §10, §11, §12 and a §16 criterion (issue #52) before the code.
2. `apps/web/lib/artifact-download.ts` + `test/artifact-download.test.ts` (100%),
   `copyFileStatusMessage` in `lib/artifact-versions.ts`, the route handler, the Content tab's
   Download link and `CopyFileButton` (+ stories), the CR notice names Download and Copy.
3. `apps/web/e2e/content-download.spec.ts` (CRLF + lone CR + non-ASCII fixture).
4. Full e2e found that the new spec's repository broke the counts of `home` and `management`:
   the spec now removes its repository, artifacts and jobs (as `categories.spec.ts` does).
5. Browser QA agent (chrome-devtools, built CLI on port 4462): fixes for its findings 2 (stale
   Copy status after switching files: keyed by version and file), 3 (at 320px the refusal
   message moved Copy under Download: the status line takes its own row) and 5 (CSP on 400/404),
   each with a regression test; finding 1 led to removing the UTF-8 notice; finding 4 (a repeated
   identical status may not be re-announced) is shared with the hash Copy button and left as a
   follow-up.

## Verification

| Command | Result |
| --- | --- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck` | pass |
| `pnpm test` | pass, 100% coverage (web 672 tests) |
| `pnpm build && pnpm verify:pack` | pass |
| `pnpm test:storybook` | 70 files, 348 tests pass |
| `playwright test` (all, port 4452, `TMPDIR=/var/tmp/issue-52-e2e`) | 215 passed |
| Red first: `content-download.spec.ts` against a build without the Content tab change and the route | fails ("Download" link missing) |

Real app: the QA agent registered a CRLF fixture in the built CLI and checked bytes, headers,
400/404 cases, keyboard, both themes, 320px and the console (no messages).

Not verified: switching versions with Download (the fixtures have one version; the href is unit
tested), a real screen reader, hover-state contrast of the new buttons, Safari/Firefox clipboard
behaviour, the 320px regression red-first (the QA screenshots of the old build are the evidence).

## Problems and deviations

- Temp directories inside a git work tree make the e2e register the work tree as a Local Git
  repository; `TMPDIR` must be outside every work tree (`/var/tmp/...`).
- After a client-side navigation the raw `<pre>` does hold CR characters (React sets the text from
  the RSC payload); only HTML parsing drops them. The lesson of 2026-10-20 was corrected.
- The QA agent opened the route of the fixture `evil.html` directly in the user's Chrome, which
  saved it to `~/Downloads`; the maintainer removed it and corrected the run (lesson below,
  AGENTS.md §3 rule).

## Lessons recorded

- Updated [2026-10-20 HTML normalises carriage returns](../lessons/2026-10-20-html-normalises-carriage-returns.md).
- [2026-11-19 Browser QA downloads stay out of ~/Downloads](../lessons/2026-11-19-browser-qa-downloads-stay-out-of-the-users-downloads.md).

## Follow-ups

- A repeated identical `role="status"` message may not be announced again (both Copy buttons).
