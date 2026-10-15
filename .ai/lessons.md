# Lessons

Durable findings, conclusions and improvements recorded by humans and AI agents — for example
after fixing a bug, discovering a tooling constraint or learning how this repository behaves.
This is the project's long-term memory. **Read it before significant work** (see `AGENTS.md`).

## How to record a lesson

1. Check this list first; update an existing lesson instead of adding a near-duplicate.
2. Copy [`templates/lesson.template.md`](templates/lesson.template.md) to
   `lessons/YYYY-MM-DD-<slug>.md` (date the lesson was learned).
3. Add a one-line entry below, newest first: `- [date] **Rule or fact** — one sentence. → link`.
4. If a lesson becomes wrong, correct or delete it (and its entry) in the same change.

Record a lesson whenever you fix a non-obvious bug, hit a misleading error, find a tooling or
platform constraint, or learn something a future agent would otherwise rediscover the hard way.
Do not record secrets, personal data or information that is already obvious from the code.

## Index

- [2026-10-15] **Don't hand out `AbortSignal.any()` built from `AbortSignal.timeout()`**: once the fired timeout signal is garbage-collected, `.aborted` reads `false` forever if nobody listens for `abort`. Use a controller, and use `collectGarbage()` in tests. → [lessons/2026-10-15-abortsignal-any-loses-gc-collected-timeout.md](lessons/2026-10-15-abortsignal-any-loses-gc-collected-timeout.md)
- [2026-10-15] **Keep 100% branch coverage deterministic** — comparators over `readdir` order and ordering by random IDs make coverage and tests machine-dependent. → [lessons/2026-10-15-deterministic-full-coverage.md](lessons/2026-10-15-deterministic-full-coverage.md)
- [2026-10-15] **Reset lifecycle flags before the first `await`** — `LocalRunner.start()` undid a concurrent `stop()`. → [lessons/2026-10-15-reset-lifecycle-flags-before-await.md](lessons/2026-10-15-reset-lifecycle-flags-before-await.md)
- [2026-10-15] **Use `regex`, not `group` negations, to allow subpaths in `no-restricted-imports`** — gitignore semantics cannot re-include a subpath of an excluded package, and later rule entries replace earlier ones. → [lessons/2026-10-15-eslint-restricted-import-negation.md](lessons/2026-10-15-eslint-restricted-import-negation.md)
- [2026-10-15] **Check the PR is still open before pushing follow-up commits** — commits pushed to an already merged PR's branch never reach `main`. → [lessons/2026-10-15-check-pr-state-before-pushing.md](lessons/2026-10-15-check-pr-state-before-pushing.md)
- [2026-10-15] **Restrict Vitest's include when build output contains `*.test.*` files** — `apps/cli/dist/examples` fixture tests were collected after `pnpm build`. → [lessons/2026-10-15-vitest-collects-build-output.md](lessons/2026-10-15-vitest-collects-build-output.md)
- [2026-10-14] **Run `pnpm verify:pack` after any bundling change** — tsup stripped the `node:` prefix (broke `node:sqlite`) and bundled CommonJS needs a `createRequire` banner; both failed only in the packed CLI. → [lessons/2026-10-14-bundler-strips-node-protocol.md](lessons/2026-10-14-bundler-strips-node-protocol.md)
- [2026-10-14] **Validate untrusted paths against the narrowest root** — `path.join()` normalises `..` and can hide escapes. → [lessons/2026-10-14-validate-paths-against-the-real-root.md](lessons/2026-10-14-validate-paths-against-the-real-root.md)
- [2026-10-14] **Toolchain constraints** — TypeScript 6.0 (typescript-eslint), ESLint 10 without eslint-plugin-react, Drizzle `sqlite-proxy` over `node:sqlite` (Node >= 22.16), pnpm 12 build approvals. → [lessons/2026-10-14-toolchain-version-constraints.md](lessons/2026-10-14-toolchain-version-constraints.md)
- [2026-10-14] **Process and HTTP testing pitfalls** — `fetch` ignores `Host`, `npx` does not forward SIGINT, `pkill -f` can kill your own shell, quote commas in YAML flow lists, macOS adds `__CF_USER_TEXT_ENCODING` to child envs and a long developer `PATH` can truncate output (updated 2026-10-16). → [lessons/2026-10-14-testing-processes-and-http.md](lessons/2026-10-14-testing-processes-and-http.md)
