import 'server-only';
import { existsSync } from 'node:fs';
import { dataDirLayout, resolveDataDir, type DataDirLayout } from '@directivebench/core';
import { openDatabase, type DatabaseHandle } from '@directivebench/database';

declare global {
  var __directivebenchDb: DatabaseHandle | undefined;
}

export function getDataDir(): DataDirLayout {
  return dataDirLayout(resolveDataDir());
}

/**
 * Returns the shared SQLite connection, or `null` when the data directory has not been
 * initialised. The web process never migrates; `directivebench init`/`serve` does.
 */
export function getDatabase(): DatabaseHandle | null {
  if (globalThis.__directivebenchDb) return globalThis.__directivebenchDb;
  const layout = getDataDir();
  if (!existsSync(layout.database)) return null;
  const handle = openDatabase(layout.database);
  const migrated = handle.sqlite
    .prepare(
      "select 1 as ok from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (!migrated) {
    handle.close();
    return null;
  }
  globalThis.__directivebenchDb = handle;
  return handle;
}

export class DatabaseNotInitializedError extends Error {
  constructor() {
    super('The DirectiveBench database is not initialised. Run `directivebench init`.');
  }
}

export function requireDatabase(): DatabaseHandle {
  const handle = getDatabase();
  if (!handle) throw new DatabaseNotInitializedError();
  return handle;
}
