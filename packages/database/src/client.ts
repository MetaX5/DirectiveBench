import { AsyncLocalStorage } from 'node:async_hooks';
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
      await waitForForeignTransaction(sqlite);
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

/** A promise with its resolver (`Promise.withResolvers` is ES2024, above the configured lib). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Resolves when the transaction currently open on a connection ends (commit or rollback). */
const activeTransactions = new WeakMap<DatabaseSync, Promise<void>>();

/** The connection whose `withTransaction` callback the current async context belongs to. */
const transactionScope = new AsyncLocalStorage<DatabaseSync>();

/**
 * The connection is shared by concurrent jobs (SPEC-114 runner lanes) and the Drizzle proxy is
 * asynchronous, so a statement from outside a running `withTransaction` could otherwise execute
 * inside it and be committed or rolled back with someone else's work. Such a statement waits until
 * the transaction ends. Statements of the transaction's own callback run immediately; a
 * transaction opened outside `withTransaction` (raw `BEGIN`) is not waited for.
 */
async function waitForForeignTransaction(sqlite: DatabaseSync): Promise<void> {
  while (sqlite.isTransaction && transactionScope.getStore() !== sqlite) {
    const active = activeTransactions.get(sqlite);
    if (!active) return;
    await active;
  }
}

/**
 * Runs `fn` inside an IMMEDIATE transaction. Transactions on the same connection are serialised
 * because the Drizzle proxy API is asynchronous while the connection is shared, and statements
 * issued outside `fn` meanwhile wait for the transaction to end. Callers must not await unrelated
 * I/O inside the callback.
 */
export async function withTransaction<T>(
  handle: DatabaseHandle,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const previous = transactionQueues.get(handle.sqlite) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() =>
      transactionScope.run(handle.sqlite, async () => {
        const ended = deferred();
        activeTransactions.set(handle.sqlite, ended.promise);
        try {
          handle.sqlite.exec('BEGIN IMMEDIATE');
          const result = await fn(handle.db);
          handle.sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          if (handle.sqlite.isTransaction) handle.sqlite.exec('ROLLBACK');
          throw error;
        } finally {
          activeTransactions.delete(handle.sqlite);
          ended.resolve();
        }
      }),
    );
  transactionQueues.set(handle.sqlite, run);
  return run;
}

export function ensureDatabaseDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
