# ADR-0014: Server-side syntax highlighting of output files with Shiki

- **Status:** Accepted (maintainer decision D20, 2026-10-29)
- **Date:** 2026-10-29
- **Deciders:** Project maintainer (decision D20 of the UI decisions on PR #155; pending review of
  this record)
- **Related:** [SPEC-123](../specs/2026-10-29-agent-run-output-files.md) §6.7 (FR-123-70 to
  FR-123-77), NFR-123-07, §12, §17 and §21 Phase 3a;
  [SPEC-004 §4](../specs/2026-10-14-technology-stack.md#4-dependency-policy) dependency policy;
  [SPEC-014](../specs/2026-10-15-engineering-standards.md) §5.6; PR #154 (spec), PR #155
  (components)

## Context

SPEC-123 shows the files an agent run wrote in `FileView` and compares them in
`SideBySideDiff`. Plain monospaced text is hard to read for code, configuration and Markdown,
which are most of what agents write. Constraints:

- The files are untrusted (a hostile fixture or prompt can make the agent write anything), so
  nothing may be rendered as HTML (SPEC-123 §12).
- The web app never runs processes; it reads SQLite and renders (SPEC-014 §3.3).
- The published CLI's runtime `dependencies` are only `next`, `react` and `react-dom`; everything
  else is bundled, with no native addons (SPEC-004 §4.2 and §4.3).
- Colours must come from design-system tokens and reach 4.5:1 in both themes on plain and tinted
  diff rows (AGENTS.md §7).
- Kept files can be up to 1 MiB; highlighting must be bounded and must never fail a page.
- AGENTS.md rule 9 and SPEC-014 §5.6 allow a dependency only for what a few lines of local code
  cannot cover. Tokenizers for a dozen languages are not a few lines.

## Decision

1. Use **Shiki** (MIT, 4.x; 4.5.0 on 2026-10-29) through its `@shikijs/core`,
   `@shikijs/engine-javascript` and `@shikijs/langs` packages (not the `shiki` umbrella package,
   which Next.js keeps external, and pnpm allows importing only direct dependencies) in `apps/web` only, called from
   `apps/web/lib/syntax-highlight.ts` (`server-only`) by App Router Server Components. No
   highlighter code reaches the browser.
2. Use the fine-grained core (`createHighlighterCore`) with a fixed list of grammars and the
   JavaScript regular-expression engine (no WebAssembly, no native code). The language comes from
   the file extension through a fixed map (SPEC-123 FR-123-71); there is no auto-detection.
3. Output tokens (`codeToTokens`) and render them as React elements; never use Shiki's HTML
   output or `dangerouslySetInnerHTML`.
4. One DirectiveBench theme built with Shiki's CSS-variables theme (`--syntax-*` variables),
   whose light and dark values are new design-system tokens.
5. Bound the work: `SYNTAX_HIGHLIGHT_MAX_BYTES` (256 KiB), a maximum line length and a per-line
   time limit; above them, or on any error, render plain text with a note. The per-line limit is
   cooperative only (Shiki's JavaScript scanner runs a synchronous `RegExp.exec`), so tokenizing
   runs in a terminable `node:worker_threads` worker with an aggregate 2 s deadline per page
   render (SPEC-123 FR-123-78), added after a Codex review.
6. Bundle Shiki into the Next.js server build. Next.js 16.4 lists `shiki` in its default
   `serverExternalPackages`, so the implementation must make sure it is bundled (for example by
   importing the `@shikijs/*` entry points) and prove it with `pnpm verify:pack`; it is not added
   to the CLI's runtime `dependencies`.
7. Deliver it as its own phase (SPEC-123 Phase 3a) after capture; it blocks no other phase.

## Alternatives considered

- **lowlight** (highlight.js grammars as a syntax tree) and **refractor** (Prism grammars as a
  syntax tree): token output fits React, but their regular-expression grammars are less accurate
  than TextMate grammars on modern TypeScript and TSX, PHP mixed with HTML, and nested languages
  in Markdown. Not chosen.
- **highlight.js** directly: large once its languages are bundled, returns an HTML string, and
  its distinguishing feature, language auto-detection, is explicitly unwanted. Not chosen.
- **Any client-side highlighter** (Shiki, Prism or highlight.js in the browser): ships grammars
  and an engine to every page that shows a file. Not chosen.
- **A hand-written tokenizer** (as ADR-0013 did for Markdown blocks): one language would be
  feasible, a dozen accurate ones are not, and colouring is a reading aid, not a measurement that
  needs a reference-checked implementation. Not chosen.
- **No highlighting**: the state before D20; the maintainer decided against it.

## Benefits

- Colouring matches what authors see in VS Code (same TextMate grammars).
- No client JavaScript cost; no HTML injection path; colours follow the design tokens and both
  themes without a second pass.
- Failure and size are bounded and degrade to the plain text that exists today.

## Drawbacks

- A new dependency tree in the web build (`@shikijs/*`, `@shikijs/vscode-textmate`): more
  supply-chain surface (lockfile and `pnpm audit --prod` cover it) and a larger server build.
- The JavaScript regex engine may not support every construct of every grammar; the unit tests
  highlight a sample per listed language with it, and a grammar that fails is removed from the
  list rather than switching to the WebAssembly engine without a new decision.
- Token data adds to the HTML and RSC payload of a page, bounded by the 256 KiB limit per shown
  text.

## Consequences

- SPEC-123 gains §6.7, NFR-123-07, AC-12 to AC-15 and Phase 3a.
- `apps/web/package.json` gains `@shikijs/core`, `@shikijs/engine-javascript` and `@shikijs/langs`; `globals.css` gains the `--syntax-*` tokens;
  `FileView` and `SideBySideDiff` accept an optional highlight result.
- `pnpm verify:pack` must cover a highlighted file, so a Next.js upgrade that changes external
  packages is caught.

## Status

Accepted by the maintainer as D20 on 2026-10-29. Revisit if the server build or page payload grows
beyond what the bound allows, or if Shiki changes its packaging so that it cannot be bundled.
