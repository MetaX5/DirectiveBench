import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';
import { migrateDatabase, openDatabase, type DatabaseHandle } from '../../src/index';

export const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface TestDatabase {
  handle: DatabaseHandle;
  /** Temporary directory that holds the database file; removed by `dispose`. */
  dir: string;
  dispose(): void;
}

/**
 * The single place tests obtain a database. It opens a fresh, fully migrated database in its own
 * temporary directory. Repository tests must get their handle from here (directly or through
 * `useTestDatabase`) so that a second backend can later be added by parametrising this helper.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'directivebench-db-'));
  const handle = openDatabase(join(dir, 'test.db'));
  await migrateDatabase(handle, migrationsFolder);
  return {
    handle,
    dir,
    dispose: () => {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Registers hooks that give every test in the current scope its own migrated database.
 * Returns an accessor because the handle only exists once `beforeEach` has run.
 */
export function useTestDatabase(): () => DatabaseHandle {
  let current: TestDatabase | undefined;
  beforeEach(async () => {
    current = await openTestDatabase();
  });
  afterEach(() => {
    current?.dispose();
    current = undefined;
  });
  return () => {
    if (!current) throw new Error('useTestDatabase() handle accessed outside a test');
    return current.handle;
  };
}

/** Creates an empty temporary directory and returns it with a cleanup function. */
export function makeTempDir(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'directivebench-db-'));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
