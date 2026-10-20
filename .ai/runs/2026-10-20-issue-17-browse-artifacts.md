---
title: Browse all discovered artifacts in one place and preview their content (issue #17, E01-S03)
date: 2026-10-20
agent: Claude Code / claude-opus-5-5
trigger: maintainer request — om-auto-fix-issue 17 (feature route, covering spec SPEC-101)
status: completed
branch: feat/issue-17-browse-artifacts
specs: [SPEC-101, SPEC-007, SPEC-008, SPEC-013, SPEC-014]
---

# Run: Browse and preview artifacts

Issue: #17

## Objective

Implement the acceptance criteria of issue #17 (E01-S03):

1. With artifacts from at least two registered repositories, `/artifacts` lists all of them with
   type, repository and occurrence count.
2. Filters by repository, type and category narrow the list and are reflected in the URL.
3. The detail Content tab shows rendered and raw content of the selected version, with a file
   tree for multi-file skills (FR-101-15).
4. The detail Overview lists the occurrences (repository and path).
5. `<script>` and `javascript:` links are displayed inertly; supporting scripts are text only
   (FR-101-18).
6. A Playwright test registers a fixture repository, scans it, opens Artifacts and checks that
   the raw preview equals the source file byte for byte.

Out of scope: diffs between versions, tags/notes editing, duplicate linking, categories
CRUD/assignment (#22), rescans/new versions (#19), GitHub registration (#18, parallel run).

## Plan

1. Database: `listArtifacts(db, filter)` filters by `type`, `category`, `repository` (active
   occurrences, SQL `exists`) and `q` (in JavaScript, Unicode case folding); list items carry
   `repositories` (id + name) and `occurrenceCount` instead of `sources`; detail occurrences are
   ordered by repository name and path.
2. Web logic in `apps/web/lib` (100 % unit coverage): Zod parsing of list and detail search
   params and the route id (invalid values ignored with a notice), content selection (version,
   file), file tree, labels; a safe Markdown parser (`lib/markdown.ts`) producing a syntax tree.
3. Components: `components/artifacts/markdown.tsx` renders the tree as React elements only;
   `content-tab.tsx` (version selector, file tree, rendered + raw view). The detail page becomes
   server-rendered `?tab=` tabs; the list page gets Repository and Occurrences columns and a
   repository filter.
4. Playwright: `e2e/registry.spec.ts` (two fixture repositories registered and scanned through the
   UI, filters in the URL, Overview occurrences, Content tab, inert script/`javascript:`/image,
   byte-for-byte raw view); `management.spec.ts` adapted to the tabs.
5. SPEC-101 filled in (§10, §11 list/detail URL contract, §12 rendering contract, §20 status).

No re-planning was needed.

## Decisions

- **No Markdown dependency.** Nothing suitable was installed; a renderer that emits HTML strings
  (marked, markdown-it) would need a server-side sanitiser (DOMPurify + jsdom). A small parser that
  returns a syntax tree rendered as React elements cannot emit raw HTML at all, and costs no new
  supply-chain surface (SPEC-007 T7). Trade-off: a CommonMark subset (no setext headings, nested
  brackets in link text, parentheses inside link destinations, reference links, HTML entities).
- **Relative links are inert** (they point into the artifact's repository, not this app);
  **images are never loaded** (local-first, no third-party requests). Listed in the PR as
  decisions needed.
- **Tabs are links with `?tab=`** (server-rendered, bookmarkable, no client JavaScript); Overview
  is the default tab, so the existing e2e test now opens Content, Versions and Benchmarks.
- **Category filter options are all non-archived categories**, not only assigned ones (the data
  exists; assignment is #22).
- **Occurrence count = active occurrences**; the repository filter matches active occurrences
  only, consistent with the Repositories page's artifact count.

## Work performed

1. `packages/database`: `ArtifactListFilter`, filtered `listArtifacts`, `repositories` and
   `occurrenceCount` on list items, ordered detail occurrences; tests "listArtifacts filters" and
   "orders occurrences by repository name and path".
2. `apps/web/lib/artifacts.ts`, `apps/web/lib/markdown.ts` with `test/artifacts.test.ts` and
   `test/markdown.test.ts` (incl. `javascript:` variants browsers still run, nesting cap and a
   pathological-input timing test).
3. `apps/web/components/artifacts/{markdown,content-tab}.tsx`, rewritten
   `apps/web/app/artifacts/[id]/page.tsx`, updated `apps/web/app/artifacts/page.tsx`.
4. `apps/web/e2e/registry.spec.ts`, `apps/web/e2e/management.spec.ts`.
5. SPEC-101, two lessons, this log.

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm verify:pack
  && pnpm test:e2e` — all passed on 2026-10-20: unit tests core 175, database 115, agent-adapters
  34, benchmark-engine 110, runner 106, cli 75, web 133, all at 100 % coverage; packaging
  verification passed; Playwright 31 passed (4 new in `registry.spec.ts`).
- Real app: built CLI with a temporary `--data-dir` (`demo`, then `serve --port 4431`), two local
  fixture directories registered and scanned through the UI with a headless Chromium script. The
  list showed 5 artifacts (two `AGENTS.md` from different repositories, each with its own
  repository and occurrence count 1); the repository filter put `repository=repo_…` in the URL and
  narrowed to 2 rows; a skill with `<script>document.title='PWNED'</script>`, an `<iframe>`, a
  `javascript:` link and a tab-split `java\tscript:` link rendered with 0 iframes, 0
  `javascript:` hrefs, no dialog, and the title unchanged after clicking the inert links; the
  supporting `scripts/x.sh` showed "shown as text only" and its exact text; a CRLF `AGENTS.md`
  showed the CR notice; `?type=script` showed "Ignored invalid value in the URL: type."; the
  HTML and the RSC payload carry the content escaped (`&lt;script&gt;`, `\u003cscript\u003e`).
- **Not verified:** keyboard-only navigation of the tabs and file tree beyond them being links;
  NFR-101-01 list timing with 10 000 artifacts (filters run in SQL, text search in JavaScript);
  CRLF byte-for-byte equality in the page (the browser cannot show CR — see lesson); binary files
  (not stored in the MVP).

## Problems and deviations

- `getByLabel('Type')` matched the Category select too (its wrapping label's name includes the
  option "TypeScript"); the test addresses selects by `name` (lesson recorded).
- A code-span failure cache in the Markdown parser was unreachable (an unmatched backtick run of
  one length cannot recur) and was removed instead of excluded from coverage.
- `registry.spec.ts` must sort after `management.spec.ts`: the latter expects no `rule` artifacts.
  This ordering dependency already existed for `repositories.spec.ts`.

## Independent review (PR #50)

- Round 1 at `0b825e3`: REQUEST_CHANGES. Major: GFM table rows padded to the header width let a
  104 KB file produce 50 million cells (4.3 s, out-of-memory rendering) — fixed by keeping each
  row's own cells (at most the header's), regression test with the reviewer's input (now 13 ms,
  2 000 cells; the full 200 000-character variant 27 ms). Also fixed: `find` now remembers
  successful searches too (`[`×199 999 + `]` 4 ms instead of quadratic `indexOf`), list rows are
  grouped with maps instead of a filter per row, the empty state uses `hasArtifacts` instead of a
  second full list query, the category parameter accepts any `slugify`-shaped slug up to
  `MAX_SLUG_PARAM_LENGTH`, SPEC-101 §12/§20 wording corrected.

## Lessons recorded

- [The DOM cannot show a carriage return](../lessons/2026-10-20-html-normalises-carriage-returns.md)
- [getByLabel matches substrings](../lessons/2026-10-20-getbylabel-matches-wrapping-label-options.md)
- Updated [An alias limit is not a size limit](../lessons/2026-10-20-alias-limits-are-not-size-limits.md) with the table amplification case.

## Follow-ups

- Exact-bytes copy/download of a file (a `text/plain` + `nosniff` response) for CRLF files.
- Remaining FR-101-11 list features: sorting, pagination, content search, the other filters,
  removable filter chips, "Show removed".
- The list's "Mock agent" label next to scores (FR-101-14) is still missing on the list page.
- `registry.spec.ts` uses the Repositories page's "Path" field; #18 (GitHub URL registration) may
  rename it.
