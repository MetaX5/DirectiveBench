# Next.js component quality — specification-only example

**Status: specification only.** `benchmark.yaml` validates against the schema (checked in CI),
but the fixture has not been built and the benchmark cannot run yet. It needs the planned
`docker` environment and a real agent adapter (here Codex; see `.ai/specs/integrations/openai-codex.md`).

Any code-quality skill, `AGENTS.md` instruction or Cursor rule can be evaluated against it.

## Fixture specification (`./fixture`, to be built)

A minimal Next.js App Router project with pinned dependencies (`package-lock.json`):

```
fixture/
  package.json            # next, react, react-dom, typescript, vitest, @testing-library/react,
                          # jsdom, eslint, eslint-plugin-react-hooks
  tsconfig.json           # strict
  vitest.config.ts        # jsdom environment
  eslint.config.mjs
  app/search/page.tsx     # Server Component rendering <SearchResults query=… />
  components/search-results.tsx   # the defective Client Component
  lib/search-api.ts       # fetchResults(query, { signal }) → Promise<Result[]>
  components/search-results.test.tsx  # visible smoke test: renders results
```

Defects in `components/search-results.tsx`:

1. `useEffect` fetches without cancellation, so a slow earlier response overwrites a newer one.
2. Missing dependency in the effect's dependency array (`query`).
3. Rejected promises are unhandled; an API error crashes the tree.
4. `any` used for the result type; `tsc --noEmit` fails after the hidden tests add typed usage.

## Hidden verification (`./verification`)

`components/search-results.hidden.test.tsx` uses fake timers and a controllable fetch mock to
assert that only the latest query's results render, that an error message is shown on failure
(with `role="alert"`), and that a loading indicator is shown while pending.

## Tooling notes

- Vitest and ESLint are deterministic and fast; prefer them as weighted assertions.
- A Playwright check (`npx playwright test`) against `next build && next start` is possible but
  heavy; add it as a separate low-weight assertion only once Docker execution exists.
