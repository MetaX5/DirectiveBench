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
      // The check and the statement run in the same synchronous step: an `await` between them
      // would let a queued `withTransaction` begin first, and the statement would join it.
      for (let open = foreignTransaction(sqlite); open; open = foreignTransaction(sqlite)) {
        await open;
      }
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

/** The transaction a `withTransaction` call has open on a connection, and when it ends. */
interface OpenTransaction {
  /** Resolves when the transaction ends (commit or rollback). */
  ended: Promise<void>;
}

const openTransactions = new WeakMap<DatabaseSync, OpenTransaction>();

/**
 * The `withTransaction` call the current async context belongs to. Identifying the call rather
 * than the connection means a continuation that outlives its transaction (a callback that was not
 * awaited) is treated as outside code, not as part of the next transaction on the connection.
 */
const transactionScope = new AsyncLocalStorage<OpenTransaction>();

/**
 * The connection is shared by concurrent jobs (SPEC-114 runner lanes) and the Drizzle proxy is
 * asynchronous, so a statement from outside a running `withTransaction` could otherwise execute
 * inside it and be committed or rolled back with someone else's work. Returns the end of such a
 * foreign transaction to wait for, or `undefined` when the statement may run now: no transaction
 * is open, the statement belongs to the open transaction's callback, or the transaction was opened
 * outside `withTransaction` (raw `BEGIN`, not waited for).
 *
 * Synchronous on purpose: the caller must run its statement in the same step as a check that
 * returned `undefined`, with no `await` in between.
 */
function foreignTransaction(sqlite: DatabaseSync): Promise<void> | undefined {
  if (!sqlite.isTransaction) return undefined;
  const open = openTransactions.get(sqlite);
  if (!open || transactionScope.getStore() === open) return undefined;
  return open.ended;
}

/**
 * Runs `fn` inside an IMMEDIATE transaction. Transactions on the same connection are serialised
 * because the Drizzle proxy API is asynchronous while the connection is shared, and statements
 * issued outside `fn` meanwhile wait for the transaction to end. Callers must not await unrelated
 * I/O inside the callback. Calls cannot be nested: `withTransaction` on the same connection from
 * inside `fn` would wait for the transaction it runs in, so it is rejected instead of deadlocking.
 */
export async function withTransaction<T>(
  handle: DatabaseHandle,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const current = openTransactions.get(handle.sqlite);
  if (current && transactionScope.getStore() === current) {
    throw new Error(
      "withTransaction cannot be nested: run the inner statements on the callback's db instead",
    );
  }
  const previous = transactionQueues.get(handle.sqlite) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => {
      const ended = deferred();
      const open: OpenTransaction = { ended: ended.promise };
      return transactionScope.run(open, async () => {
        openTransactions.set(handle.sqlite, open);
        try {
          handle.sqlite.exec('BEGIN IMMEDIATE');
          const result = await fn(handle.db);
          handle.sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          if (handle.sqlite.isTransaction) handle.sqlite.exec('ROLLBACK');
          throw error;
        } finally {
          openTransactions.delete(handle.sqlite);
          ended.resolve();
        }
      });
    });
  transactionQueues.set(handle.sqlite, run);
  return run;
}

export function ensureDatabaseDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
