import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Browser tests run the built CLI (`pnpm build` first) against a fresh data directory seeded by
// `directivebench demo`, exactly as an end user would start the app. All spec files share that
// single server, runner and SQLite database, and some tests seed or change it (approval, held
// jobs), so they run serially in one worker.
const port = Number(process.env.DIRECTIVEBENCH_E2E_PORT ?? 4399);

// Every temporary directory of a run lives under one root, so the run removes it all when it
// ends, also after a failure (AGENTS.md §3: the temporary directory can be RAM). The config is
// evaluated again in each worker; the environment variable keeps one root, and only the process
// that created it removes it. DIRECTIVEBENCH_E2E_KEEP_TMP=1 keeps it for debugging.
const ownsTmpRoot = process.env.DIRECTIVEBENCH_E2E_TMP === undefined;
process.env.DIRECTIVEBENCH_E2E_TMP ??= mkdtempSync(join(tmpdir(), 'directivebench-e2e-'));
const tmpRoot = process.env.DIRECTIVEBENCH_E2E_TMP;
if (ownsTmpRoot && process.env.DIRECTIVEBENCH_E2E_KEEP_TMP !== '1') {
  process.once('exit', () => rmSync(tmpRoot, { recursive: true, force: true }));
}

process.env.DIRECTIVEBENCH_E2E_DATA_DIR ??= mkdtempSync(join(tmpRoot, 'data-'));
const dataDir = process.env.DIRECTIVEBENCH_E2E_DATA_DIR;

// A fake `claude` first on the server's PATH makes the Agent Connections readiness deterministic
// (installed, supported version, logged in) on every machine, and keeps a real `claude` — with
// the developer's login — out of the browser tests. It answers only `--version` and
// `auth status`; the API key is cleared so API key mode reads as not configured.
// The config is evaluated again in each worker; the environment variable keeps one directory.
process.env.DIRECTIVEBENCH_E2E_AGENT_BIN ??= mkdtempSync(join(tmpRoot, 'bin-'));
const fakeAgentBin = process.env.DIRECTIVEBENCH_E2E_AGENT_BIN;
writeFileSync(
  join(fakeAgentBin, 'claude'),
  [
    '#!/bin/sh',
    'if [ "$1" = --setting-sources ]; then shift 2; fi',
    'case "$1" in',
    '  --version) echo "2.1.302 (Claude Code)" ;;',
    `  auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}' ;;`,
    '  *) echo "fake claude: unsupported arguments" >&2; exit 64 ;;',
    'esac',
    '',
  ].join('\n'),
);
chmodSync(join(fakeAgentBin, 'claude'), 0o755);

const cli = `node ${join(import.meta.dirname, '..', 'cli', 'dist', 'cli.js')} --data-dir ${dataDir}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `${cli} demo && ${cli} serve --no-open --port ${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      PATH: `${fakeAgentBin}${delimiter}${process.env.PATH ?? ''}`,
      ANTHROPIC_API_KEY: '',
    },
  },
});
