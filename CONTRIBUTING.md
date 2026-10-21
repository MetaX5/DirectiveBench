# Contributing to DirectiveBench

Thank you for your interest in DirectiveBench. The project is in an early bootstrap phase, so
the specifications in [`.ai/specs/`](.ai/specs/README.md) matter as much as the code.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Workflow

1. Read [`AGENTS.md`](AGENTS.md) — it describes the workflow for humans and AI agents alike:
   specs first, tests, verification, run logs and lessons.
2. For a significant change, open an issue and add or update a draft spec in `.ai/specs/`
   (`YYYY-MM-DD-slug.md`) before writing code. Record significant design decisions as ADRs in
   `.ai/decisions/`.
3. Work on a branch (`feat/…`, `fix/…`, `docs/…`), use
   [Conventional Commits](https://www.conventionalcommits.org/), and open a pull request
   (`gh pr create`). Fill in the verification section of the PR template with real results.

## Development setup

```bash
pnpm install        # Node >= 22.16 and pnpm (see packageManager in package.json)
pnpm dev
```

Quality gate before opening a PR:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm build && pnpm verify:pack    # when touching apps/cli, apps/web, packaging or dependencies
pnpm test:e2e                     # when touching the UI
```

Tests must not need credentials or paid API calls; use the deterministic mock agent.

## Principles

- Local-first: nothing may require a cloud account or hosted service for local use.
- No fake functionality: unfinished features are visibly marked as planned.
- Deterministic-first evaluation; mock results are always labelled as such.
- Imported content and benchmark scripts are untrusted.
- Add dependencies only when clearly needed.

## Releasing (maintainers)

1. In a pull request, set `version` in `apps/cli/package.json` (and add the changelog entry).
2. After it merges, create a GitHub release with the tag `v<version>` on `main`; mark it as a
   pre-release to publish under the npm dist-tag `next`.
3. The `Release` workflow checks the tag, builds, runs `pnpm verify:pack` and publishes to npm
   with provenance. Never publish by hand (SPEC-010 §12).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
