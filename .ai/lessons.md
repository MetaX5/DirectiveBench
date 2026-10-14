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

- [2026-10-14] **Run `pnpm verify:pack` after any bundling change** — tsup stripped the `node:` prefix and broke `node:sqlite` only in the packed CLI. → [lessons/2026-10-14-bundler-strips-node-protocol.md](lessons/2026-10-14-bundler-strips-node-protocol.md)
- [2026-10-14] **Validate untrusted paths against the narrowest root** — `path.join()` normalises `..` and can hide escapes. → [lessons/2026-10-14-validate-paths-against-the-real-root.md](lessons/2026-10-14-validate-paths-against-the-real-root.md)
- [2026-10-14] **Toolchain constraints** — TypeScript 6.0 (typescript-eslint), ESLint 10 without eslint-plugin-react, Drizzle `sqlite-proxy` over `node:sqlite` (Node >= 22.16), pnpm 12 build approvals. → [lessons/2026-10-14-toolchain-version-constraints.md](lessons/2026-10-14-toolchain-version-constraints.md)
- [2026-10-14] **Process and HTTP testing pitfalls** — `fetch` ignores `Host`, `npx` does not forward SIGINT, `pkill -f` can kill your own shell, quote commas in YAML flow lists. → [lessons/2026-10-14-testing-processes-and-http.md](lessons/2026-10-14-testing-processes-and-http.md)
