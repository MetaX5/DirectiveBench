import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@directivebench/database';
import { DatabaseNotInitializedError, getDataDir, getDatabase, requireDatabase } from '../lib/db';
import { createTempDataDir, initialiseDatabase, resetCachedDatabase } from './support/data-dir';

let dataDir: ReturnType<typeof createTempDataDir>;

beforeEach(() => {
  dataDir = createTempDataDir();
  vi.stubEnv('DIRECTIVEBENCH_DATA_DIR', dataDir.root);
  resetCachedDatabase();
});

afterEach(() => {
  resetCachedDatabase();
  vi.unstubAllEnvs();
  dataDir.remove();
});

describe('getDataDir', () => {
  it('resolves the layout from DIRECTIVEBENCH_DATA_DIR', () => {
    expect(getDataDir()).toEqual({
      root: dataDir.root,
      database: dataDir.database,
      config: dataDir.config,
      fixtures: dataDir.fixtures,
      logs: dataDir.logs,
      cache: dataDir.cache,
    });
  });
});

describe('getDatabase', () => {
  it('returns null and creates nothing when the data directory is not initialised', () => {
    expect(getDatabase()).toBeNull();
    expect(existsSync(dataDir.database)).toBe(false);
  });

  it('returns null for a database file that has not been migrated (the web never migrates)', async () => {
    openDatabase(dataDir.database).close();
    expect(getDatabase()).toBeNull();
    expect(globalThis.__directivebenchDb).toBeUndefined();

    // The unmigrated connection was closed and not cached: once migrated, it opens normally.
    await initialiseDatabase(dataDir.database);
    expect(getDatabase()?.path).toBe(dataDir.database);
  });

  it('opens a migrated database once and reuses the connection', async () => {
    await initialiseDatabase(dataDir.database);
    const handle = getDatabase();
    expect(handle?.path).toBe(dataDir.database);
    expect(handle?.sqlite.isOpen).toBe(true);
    expect(getDatabase()).toBe(handle);
    expect(globalThis.__directivebenchDb).toBe(handle);
  });
});

describe('requireDatabase', () => {
  it('throws an actionable error when the database is not initialised', () => {
    expect(() => requireDatabase()).toThrow(DatabaseNotInitializedError);
    expect(() => requireDatabase()).toThrow('Run `directivebench init`');
  });

  it('returns the shared connection when the database is initialised', async () => {
    await initialiseDatabase(dataDir.database);
    expect(requireDatabase()).toBe(getDatabase());
  });
});
