import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataDirLayout } from '@directivebench/core';
import { CliError, ExitCode, resolveAssets } from '../src/runtime';
import { initialize, readConfig } from '../src/setup';

const { migrationsDir } = resolveAssets();
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-cli-setup-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function expectCliError(promise: Promise<unknown>, exitCode: ExitCode, message: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).exitCode).toBe(exitCode);
  expect((error as CliError).message).toMatch(message);
}

describe('initialize', () => {
  it('creates the layout, a default config and a migrated database, idempotently', async () => {
    const root = join(tempDir(), 'data');
    const first = await initialize(root, migrationsDir);
    try {
      expect(first.createdConfig).toBe(true);
      expect(first.appliedMigrations).toBeGreaterThan(0);
      for (const dir of ['fixtures', 'logs', 'cache'])
        expect(existsSync(join(root, dir))).toBe(true);
      expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toMatchObject({
        server: { host: '127.0.0.1', port: 4280 },
        installationId: first.config.installationId,
      });
      expect(first.config.installationId).toMatch(/^[0-9a-f-]{36}$/);
      const categories = first.handle.sqlite
        .prepare('select count(*) as n from categories')
        .get() as {
        n: number;
      };
      expect(categories.n).toBeGreaterThan(0);
    } finally {
      first.handle.close();
    }

    const second = await initialize(root, migrationsDir);
    second.handle.close();
    expect(second.createdConfig).toBe(false);
    expect(second.appliedMigrations).toBe(0);
    expect(second.config.installationId).toBe(first.config.installationId);
  });

  it('keeps an existing config.json, adding only a missing installationId', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'config.json'), JSON.stringify({ server: { port: 5123 } }));
    const workspace = await initialize(root, migrationsDir);
    workspace.handle.close();
    expect(workspace.createdConfig).toBe(false);
    expect(workspace.config.server.port).toBe(5123);
    expect(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))).toEqual({
      server: { port: 5123 },
      installationId: workspace.config.installationId,
    });
  });

  it('reports a data directory that cannot be created', async () => {
    const file = join(tempDir(), 'not-a-dir');
    writeFileSync(file, '');
    await expectCliError(
      initialize(join(file, 'data'), migrationsDir),
      ExitCode.DataDir,
      /^Data directory .*not-a-dir\/data is not writable: /,
    );
  });

  it('reports an invalid config.json as a usage error', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'config.json'), '{ not json');
    await expectCliError(initialize(root, migrationsDir), ExitCode.Usage, /is not valid JSON/);
  });

  it('reports database initialisation failures', async () => {
    const root = tempDir();
    await expectCliError(
      initialize(root, join(root, 'no-migrations')),
      ExitCode.DataDir,
      /^Database initialisation failed: /,
    );
  });
});

describe('readConfig', () => {
  it('rethrows errors that are not configuration errors unchanged', () => {
    const root = tempDir();
    mkdirSync(join(root, 'config.json'));
    let caught: unknown;
    try {
      readConfig(dataDirLayout(root));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CliError);
    expect((caught as NodeJS.ErrnoException).code).toBe('EISDIR');
  });
});
