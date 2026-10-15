import * as fs from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../src/commands';
import type * as RuntimeModule from '../src/runtime';
import { ExitCode, checkSqlite, resolveAssets, type Assets } from '../src/runtime';
import { initialize } from '../src/setup';
import { fakeNodeVersion } from './support/node-version';

// existsSync/accessSync pass through to the real implementation unless a test overrides them, to
// simulate conditions a test process cannot create (a missing filesystem root, an unwritable
// directory regardless of the user running the tests).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), accessSync: vi.fn(actual.accessSync) };
});
vi.mock('../src/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeModule>();
  return {
    ...actual,
    resolveAssets: vi.fn(actual.resolveAssets),
    checkSqlite: vi.fn(actual.checkSqlite),
  };
});

const actualFs = await vi.importActual<typeof fs>('node:fs');
const actualRuntime = await vi.importActual<typeof RuntimeModule>('../src/runtime');
const sourceAssets = actualRuntime.resolveAssets;
const migrationCount = actualFs
  .readdirSync(sourceAssets().migrationsDir)
  .filter((f) => f.endsWith('.sql')).length;

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

const tempDirs: string[] = [];
const servers: Server[] = [];
let restoreNode: (() => void) | undefined;

function tempDir(): string {
  const dir = actualFs.mkdtempSync(join(tmpdir(), 'db-cli-doctor-'));
  tempDirs.push(dir);
  return dir;
}

/** A PATH containing a working `claude`, a broken `codex` and no `cursor-agent`. */
function fakeAgentPath(): string {
  const bin = tempDir();
  actualFs.writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.0 (Claude Code)"\n', {
    mode: 0o755,
  });
  actualFs.writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return bin;
}

async function listen(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const port = await listen();
  await new Promise((resolve) => servers.pop()?.close(resolve));
  return port;
}

function packagedAssets(): Assets {
  const dir = tempDir();
  return {
    mode: 'packaged',
    webDir: join(dir, 'web'),
    migrationsDir: sourceAssets().migrationsDir,
    examplesDir: join(dir, 'examples'),
    nextBin: join(dir, 'next'),
  };
}

async function initialisedDataDir(): Promise<string> {
  const root = join(tempDir(), 'data');
  (await initialize(root, sourceAssets().migrationsDir)).handle.close();
  return root;
}

async function runDoctor(dataDir: string, json = true) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await doctorCommand({ dataDir, json });
  const lines = log.mock.calls.map((call) => String(call[0]));
  log.mockRestore();
  if (!json) return { code, checks: [] as Check[], lines };
  const output = JSON.parse(lines.at(-1) ?? '') as { checks: Check[] };
  return { code, checks: output.checks, lines };
}

const find = (checks: Check[], name: string) => checks.find((c) => c.name === name);

beforeEach(() => {
  vi.stubEnv('PATH', fakeAgentPath());
  vi.stubEnv('DIRECTIVEBENCH_HOST', '127.0.0.1');
});

afterEach(async () => {
  restoreNode?.();
  restoreNode = undefined;
  vi.unstubAllEnvs();
  vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync);
  vi.mocked(fs.accessSync).mockImplementation(actualFs.accessSync);
  vi.mocked(resolveAssets).mockImplementation(sourceAssets);
  vi.mocked(checkSqlite).mockReset().mockImplementation(actualRuntime.checkSqlite);
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const dir of tempDirs.splice(0)) actualFs.rmSync(dir, { recursive: true, force: true });
});

describe('doctor', () => {
  it('reports a healthy installation in text form', async () => {
    const dataDir = await initialisedDataDir();
    vi.stubEnv('DIRECTIVEBENCH_PORT', String(await freePort()));
    vi.mocked(resolveAssets).mockReturnValue(packagedAssets());

    const { code, lines } = await runDoctor(dataDir, false);

    expect(code).toBe(ExitCode.Ok);
    expect(lines.filter((line) => !line.startsWith('ok  '))).toEqual([]);
    expect(lines).toContain(`ok    data-dir           ${dataDir}`);
    expect(lines).toContain(`ok    config             ${join(dataDir, 'config.json')}`);
    expect(lines).toContain(
      `ok    database           ${migrationCount}/${migrationCount} migrations applied`,
    );
    expect(lines.find((l) => l.includes(' port '))).toMatch(/127\.0\.0\.1:\d+ is free$/);
    expect(lines).toContain(
      'ok    agent:claude-code  Claude Code found (2.1.0 (Claude Code)); benchmark execution not implemented yet',
    );
    expect(lines).toContain(
      'ok    agent:codex        OpenAI Codex CLI found (version unknown); benchmark execution not implemented yet',
    );
    expect(lines).toContain(
      'ok    agent:cursor       Cursor Agent CLI not found on PATH (optional)',
    );
  });

  it('prints hints under failing checks in text form', async () => {
    restoreNode = fakeNodeVersion('20.0.0');
    const { code, lines } = await runDoctor(join(tempDir(), 'new'), false);
    expect(code).toBe(ExitCode.CheckFailed);
    const index = lines.findIndex((l) => l.startsWith('fail  node'));
    expect(lines[index]).toBe('fail  node               Node.js 20.0.0 (requires >= 22.16.0)');
    expect(lines[index + 1]).toBe(
      '      → Install Node.js 22.16 or newer (Node 24 LTS recommended).',
    );
  });

  it('fails on an unsupported runtime, missing SQLite and an invalid config', async () => {
    restoreNode = fakeNodeVersion('22.15.0');
    vi.mocked(checkSqlite).mockResolvedValue({ ok: false, message: 'node:sqlite unavailable: x' });
    const dataDir = tempDir();
    actualFs.writeFileSync(join(dataDir, 'config.json'), '{"server":{"port":"x"}}');

    const { code, checks } = await runDoctor(dataDir);

    expect(code).toBe(ExitCode.CheckFailed);
    expect(find(checks, 'node')).toMatchObject({ status: 'fail', hint: expect.any(String) });
    expect(find(checks, 'sqlite')).toEqual({
      name: 'sqlite',
      status: 'fail',
      detail: 'node:sqlite unavailable: x',
      hint: 'Use an official Node.js build >= 22.16; node:sqlite is built in.',
    });
    expect(find(checks, 'config')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('is invalid'),
      hint: `Fix or delete ${join(dataDir, 'config.json')}; defaults are used when it is absent.`,
    });
    // Without a valid config the port cannot be determined, so it is not checked.
    expect(find(checks, 'port')).toBeUndefined();
  });

  it('warns about a source checkout without a web build and a missing database', async () => {
    const dataDir = tempDir();
    const webDir = tempDir();
    vi.mocked(resolveAssets).mockReturnValue({ ...packagedAssets(), mode: 'source', webDir });
    vi.stubEnv('DIRECTIVEBENCH_PORT', String(await freePort()));

    const { code, checks } = await runDoctor(dataDir);

    expect(code).toBe(ExitCode.Ok);
    expect(find(checks, 'config')).toMatchObject({
      status: 'ok',
      detail: 'defaults (no config.json yet)',
    });
    expect(find(checks, 'web-build')).toMatchObject({
      status: 'warn',
      detail: `source: ${webDir}`,
      hint: expect.stringContaining('pnpm build'),
    });
    expect(find(checks, 'database')).toMatchObject({ status: 'warn', detail: 'not created yet' });
  });

  it('accepts a source checkout whose web app has been built', async () => {
    const webDir = tempDir();
    actualFs.mkdirSync(join(webDir, '.next'));
    actualFs.writeFileSync(join(webDir, '.next', 'BUILD_ID'), 'id');
    vi.mocked(resolveAssets).mockReturnValue({ ...packagedAssets(), mode: 'source', webDir });

    const { checks } = await runDoctor(tempDir());

    expect(find(checks, 'web-build')).toMatchObject({ status: 'ok', detail: `source: ${webDir}` });
  });

  it('warns about pending migrations, including a database that was never migrated', async () => {
    const dataDir = tempDir();
    actualFs.writeFileSync(join(dataDir, 'directivebench.db'), '');

    const { checks } = await runDoctor(dataDir);

    expect(find(checks, 'database')).toMatchObject({
      status: 'warn',
      detail: `0/${migrationCount} migrations applied`,
      hint: 'Run `directivebench init` to apply pending migrations.',
    });
  });

  it('reports a broken installation when the bundled assets cannot be located', async () => {
    vi.mocked(resolveAssets).mockImplementation(() => {
      throw new Error('Cannot locate the bundled web application');
    });

    const { code, checks } = await runDoctor(tempDir());

    expect(code).toBe(ExitCode.CheckFailed);
    expect(find(checks, 'installation')).toEqual({
      name: 'installation',
      status: 'fail',
      detail: 'Cannot locate the bundled web application',
      hint: 'Reinstall DirectiveBench (`npx directivebench@latest`).',
    });
    expect(find(checks, 'web-build')).toBeUndefined();
  });

  it('warns when the configured port is in use', async () => {
    const port = await listen();
    vi.stubEnv('DIRECTIVEBENCH_PORT', String(port));

    const { code, checks } = await runDoctor(tempDir());

    expect(code).toBe(ExitCode.Ok);
    expect(find(checks, 'port')).toMatchObject({
      status: 'warn',
      detail: `127.0.0.1:${port} is in use (another instance running?)`,
      hint: 'Stop the other process or start with --port <port>.',
    });
  });

  it('fails when the configured server options are invalid', async () => {
    vi.stubEnv('DIRECTIVEBENCH_PORT', '99999');

    const { code, checks } = await runDoctor(tempDir());

    expect(code).toBe(ExitCode.CheckFailed);
    expect(find(checks, 'port')).toMatchObject({
      status: 'fail',
      detail: 'Invalid port "99999" (expected 1–65535)',
      hint: expect.stringContaining('DIRECTIVEBENCH_PORT'),
    });
  });

  it('fails when an existing data directory is not writable', async () => {
    const dataDir = tempDir();
    vi.mocked(fs.accessSync).mockImplementation((path, mode) => {
      if (path === dataDir) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      actualFs.accessSync(path, mode);
    });

    const { checks } = await runDoctor(dataDir);

    expect(find(checks, 'data-dir')).toMatchObject({
      status: 'fail',
      detail: `${dataDir} is not writable`,
      hint: expect.stringContaining('--data-dir'),
    });
  });

  it('fails when no ancestor of a missing data directory is writable', async () => {
    const dataDir = join(tempDir(), 'missing', 'data');
    // Every ancestor, even the filesystem root, is reported missing: the search must stop there.
    vi.mocked(fs.existsSync).mockImplementation((path) =>
      dataDir.startsWith(String(path)) ? false : actualFs.existsSync(path),
    );
    vi.mocked(fs.accessSync).mockImplementation((path, mode) => {
      if (path === '/') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      actualFs.accessSync(path, mode);
    });

    const { code, checks } = await runDoctor(dataDir);

    expect(code).toBe(ExitCode.CheckFailed);
    expect(find(checks, 'data-dir')).toEqual({
      name: 'data-dir',
      status: 'fail',
      detail: `${dataDir} cannot be created: / is not writable`,
      hint: 'Choose a writable location with --data-dir / DIRECTIVEBENCH_DATA_DIR.',
    });
  });
});
