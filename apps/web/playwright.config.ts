import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Browser tests run the built CLI (`pnpm build` first) against a fresh data directory seeded by
// `directivebench demo`, exactly as an end user would start the app. All spec files share that
// single server, runner and SQLite database, and some tests seed or change it (approval, held
// jobs), so they run serially in one worker.
const port = Number(process.env.DIRECTIVEBENCH_E2E_PORT ?? 4399);
process.env.DIRECTIVEBENCH_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'directivebench-e2e-'));
const dataDir = process.env.DIRECTIVEBENCH_E2E_DATA_DIR;
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
  },
});
