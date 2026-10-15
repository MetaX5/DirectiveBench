import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirLayout, type DataDirLayout } from '@directivebench/core';
import { migrateDatabase, openDatabase } from '@directivebench/database';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/database/migrations', import.meta.url),
);

/** A throw-away data directory; never the user's real one. */
export function createTempDataDir(): DataDirLayout & { remove(): void } {
  const root = mkdtempSync(join(tmpdir(), 'directivebench-web-'));
  return { ...dataDirLayout(root), remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** Creates the database file and applies all migrations, as `directivebench init` does. */
export async function initialiseDatabase(databasePath: string): Promise<void> {
  const handle = openDatabase(databasePath);
  try {
    await migrateDatabase(handle, migrationsFolder);
  } finally {
    handle.close();
  }
}

/** Closes and forgets the connection cached by lib/db.ts. */
export function resetCachedDatabase(): void {
  globalThis.__directivebenchDb?.close();
  globalThis.__directivebenchDb = undefined;
}
