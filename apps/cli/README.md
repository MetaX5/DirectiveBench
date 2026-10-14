# directivebench

Local-first workbench for discovering, organizing, testing and benchmarking AI agent skills,
instructions and rules.

> **Status: early bootstrap (0.x).** The local web UI, SQLite registry, benchmark engine and a
> deterministic **mock** agent work end to end. Repository synchronisation and real agent
> integrations (Claude Code, Codex, Cursor) are specified but **not implemented yet**.
> This package has not been published to npm.

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

MIT licensed.
