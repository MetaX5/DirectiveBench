import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';
import * as schema from './schema';

export type Database = SqliteRemoteDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** The underlying connection. Repository code must not use it directly. */
  sqlite: DatabaseSync;
  path: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Open read-only; used by diagnostics. */
  readOnly?: boolean;
}

/**
 * Opens (and creates) a SQLite database using the built-in `node:sqlite` module, exposed to
 * Drizzle through its `sqlite-proxy` driver. No native addon is compiled on install.
 * WAL mode lets the web process read while the runner process writes.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseHandle {
  if (path !== ':memory:' && !options.readOnly) mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec('PRAGMA foreign_keys = ON');
  if (!options.readOnly && path !== ':memory:') sqlite.exec('PRAGMA journal_mode = WAL');

  const db = drizzle(
    async (query, params, method) => {
      const statement = sqlite.prepare(query);
      const values = params as SQLInputValue[];
      if (method === 'run') {
        statement.run(...values);
        return { rows: [] };
      }
      statement.setReturnArrays(true);
      if (method === 'get') {
        return { rows: statement.get(...values) as unknown as unknown[] };
      }
      return { rows: statement.all(...values) as unknown as unknown[][] };
    },
    { schema },
  );

  return {
    db,
    sqlite,
    path,
    close: () => {
      if (sqlite.isOpen) sqlite.close();
    },
  };
}

/** Applies pending Drizzle migrations (forward-only) inside a single transaction. */
export async function migrateDatabase(
  handle: DatabaseHandle,
  migrationsFolder: string,
): Promise<{ applied: number }> {
  let applied = 0;
  await migrate(
    handle.db,
    async (queries) => {
      if (queries.length === 0) return;
      handle.sqlite.exec('BEGIN IMMEDIATE');
      try {
        for (const query of queries) handle.sqlite.exec(query);
        handle.sqlite.exec('COMMIT');
      } catch (error) {
        handle.sqlite.exec('ROLLBACK');
        throw error;
      }
      applied = queries.filter((q) => q.startsWith('INSERT INTO `__drizzle_migrations`')).length;
    },
    { migrationsFolder },
  );
  return { applied };
}

const transactionQueues = new WeakMap<DatabaseSync, Promise<unknown>>();

/**
 * Runs `fn` inside an IMMEDIATE transaction. Transactions on the same connection are serialised
 * because the Drizzle proxy API is asynchronous while the connection is shared. Callers must not
 * await unrelated I/O inside the callback.
 */
export async function withTransaction<T>(
  handle: DatabaseHandle,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const previous = transactionQueues.get(handle.sqlite) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      handle.sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(handle.db);
        handle.sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        if (handle.sqlite.isTransaction) handle.sqlite.exec('ROLLBACK');
        throw error;
      }
    });
  transactionQueues.set(handle.sqlite, run);
  return run;
}

export function ensureDatabaseDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
