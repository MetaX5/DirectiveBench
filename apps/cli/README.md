# directivebench

Local-first workbench for discovering, organizing, testing and benchmarking AI agent skills,
instructions and rules.

> **Status: early (0.x).** The local web UI, SQLite registry and benchmark engine work end to
> end. You can register local repositories and public GitHub repositories (by URL) and scan them
> for skills, instructions and rules. Benchmarks run only with a deterministic **mock** agent,
> which is **not an AI evaluation**; real agent integrations (Claude Code, Codex, Cursor), private
> and GitLab repositories are specified but **not implemented yet**.

## Usage

```bash
npx directivebench            # start the local UI on http://127.0.0.1:4280 and open a browser
npx directivebench demo       # import the bundled example and run it with the mock agent
npx directivebench doctor     # diagnose the environment
npx directivebench init       # create the data directory and database only
npx directivebench --help
```

Options: `--data-dir <path>`, `--host <host>`, `--port <port>`, `--no-open`,
`--allow-network-access` (required for non-loopback hosts; the UI has no authentication).

Requires Node.js >= 22.16 (uses the built-in `node:sqlite`; no native compilation).
Data lives in an OS-specific application data directory, never inside the package.

Source, issues and documentation: <https://github.com/MetaX5/DirectiveBench>. MIT licensed.
