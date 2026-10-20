import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, getTableName, is, sql } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureDatabaseDir,
  migrateDatabase,
  openDatabase,
  schema,
  withTransaction,
  type DatabaseHandle,
} from '../src/index';
import { makeTempDir, migrationsFolder, useTestDatabase } from './support/test-database';

const { categories } = schema;

function categoryRow(slug: string) {
  return {
    id: `cat_${slug}`,
    slug,
    name: slug,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function tableNames(handle: DatabaseHandle): string[] {
  return handle.sqlite
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all()
    .map((r) => String(r.name));
}

describe('openDatabase', () => {
  let temp: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    temp = makeTempDir();
  });
  afterEach(() => temp.dispose());

  it('creates missing parent directories and enables WAL and foreign keys', () => {
    const path = join(temp.dir, 'nested', 'deeper', 'data.db');
    const handle = openDatabase(path);
    try {
      expect(existsSync(path)).toBe(true);
      expect(handle.path).toBe(path);
      expect(handle.sqlite.prepare('pragma journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(handle.sqlite.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(handle.sqlite.prepare('pragma busy_timeout').get()).toEqual({ timeout: 5000 });
    } finally {
      handle.close();
    }
  });

  it('opens an in-memory database without touching the file system or enabling WAL', async () => {
    const handle = openDatabase(':memory:');
    try {
      expect(handle.sqlite.prepare('pragma journal_mode').get()).toEqual({
        journal_mode: 'memory',
      });
      expect(existsSync(':memory:')).toBe(false);
      expect((await migrateDatabase(handle, migrationsFolder)).applied).toBe(2);
      expect(tableNames(handle)).toContain('jobs');
    } finally {
      handle.close();
    }
  });

  it('opens read-only without creating directories and rejects writes', async () => {
    const missing = join(temp.dir, 'missing', 'data.db');
    expect(() => openDatabase(missing, { readOnly: true })).toThrow();
    expect(existsSync(join(temp.dir, 'missing'))).toBe(false);

    const path = join(temp.dir, 'data.db');
    const writer = openDatabase(path);
    await migrateDatabase(writer, migrationsFolder);
    await writer.db.insert(categories).values(categoryRow('security'));
    writer.close();

    const reader = openDatabase(path, { readOnly: true });
    try {
      const rows = await reader.db.select({ slug: categories.slug }).from(categories);
      expect(rows).toEqual([{ slug: 'security' }]);
      await expect(
        reader.db.insert(categories).values(categoryRow('other')),
      ).rejects.toHaveProperty('cause.message', expect.stringMatching(/readonly/i));
    } finally {
      reader.close();
    }
  });

  it('can be closed more than once', () => {
    const handle = openDatabase(join(temp.dir, 'data.db'));
    handle.close();
    expect(handle.sqlite.isOpen).toBe(false);
    expect(() => handle.close()).not.toThrow();
  });
});

describe('ensureDatabaseDir', () => {
  it('creates the parent directory of a database path', () => {
    const temp = makeTempDir();
    try {
      const path = join(temp.dir, 'a', 'b', 'data.db');
      ensureDatabaseDir(path);
      expect(existsSync(join(temp.dir, 'a', 'b'))).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(() => ensureDatabaseDir(path)).not.toThrow();
    } finally {
      temp.dispose();
    }
  });
});

describe('migrateDatabase', () => {
  const getHandle = useTestDatabase();

  it('creates the schema and is idempotent', async () => {
    const handle = getHandle();
    expect((await migrateDatabase(handle, migrationsFolder)).applied).toBe(0);
    expect(tableNames(handle)).toEqual(
      expect.arrayContaining([
        'artifacts',
        'artifact_versions',
        'jobs',
        'benchmark_runs',
        'assertion_results',
      ]),
    );
  });

  it('rolls back every statement of a failing migration', async () => {
    const temp = makeTempDir();
    const handle = openDatabase(join(temp.dir, 'data.db'));
    try {
      const folder = join(temp.dir, 'migrations');
      mkdirSync(join(folder, 'meta'), { recursive: true });
      writeFileSync(
        join(folder, 'meta', '_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'sqlite',
          entries: [{ idx: 0, version: '6', when: 1, tag: '0000_broken', breakpoints: true }],
        }),
      );
      writeFileSync(
        join(folder, '0000_broken.sql'),
        'CREATE TABLE `ok` (`id` text);\n--> statement-breakpoint\nCREATE TABLE broken (;',
      );

      await expect(migrateDatabase(handle, folder)).rejects.toThrow(/syntax error/);
      expect(tableNames(handle)).not.toContain('ok');
      expect(handle.sqlite.isTransaction).toBe(false);
      const recorded = handle.sqlite
        .prepare('select count(*) as n from __drizzle_migrations')
        .get();
      expect(recorded).toEqual({ n: 0 });
    } finally {
      handle.close();
      temp.dispose();
    }
  });
});

describe('withTransaction', () => {
  const getHandle = useTestDatabase();

  async function slugs(handle: DatabaseHandle): Promise<string[]> {
    const rows = await handle.db
      .select({ slug: categories.slug })
      .from(categories)
      .orderBy(categories.slug);
    return rows.map((r) => r.slug);
  }

  it('commits the callback result', async () => {
    const handle = getHandle();
    const result = await withTransaction(handle, async (db) => {
      await db.insert(categories).values(categoryRow('a'));
      return 'done';
    });
    expect(result).toBe('done');
    expect(handle.sqlite.isTransaction).toBe(false);
    expect(await slugs(handle)).toEqual(['a']);
  });

  it('rolls back and rethrows when the callback fails', async () => {
    const handle = getHandle();
    const failure = new Error('boom');
    await expect(
      withTransaction(handle, async (db) => {
        await db.insert(categories).values(categoryRow('a'));
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(handle.sqlite.isTransaction).toBe(false);
    expect(await slugs(handle)).toEqual([]);
  });

  it('rethrows the original error when SQLite already rolled the transaction back', async () => {
    const handle = getHandle();
    await handle.db.insert(categories).values(categoryRow('a'));
    await expect(
      withTransaction(handle, async (db) => {
        await db.insert(categories).values(categoryRow('b'));
        // OR ROLLBACK makes SQLite end the transaction itself on the constraint violation.
        await db.run(
          sql`insert or rollback into ${categories} (id, slug, name, created_at, updated_at)
              values ('cat_dup', 'a', 'a', 'now', 'now')`,
        );
      }),
    ).rejects.toHaveProperty('cause.message', expect.stringMatching(/UNIQUE constraint failed/));
    expect(handle.sqlite.isTransaction).toBe(false);
    expect(await slugs(handle)).toEqual(['a']);
  });

  it('serialises concurrent transactions and keeps going after a failed one', async () => {
    const handle = getHandle();
    const order: string[] = [];
    const first = withTransaction(handle, async (db) => {
      order.push('first:start');
      await db.insert(categories).values(categoryRow('first'));
      await new Promise((resolve) => setImmediate(resolve));
      order.push('first:end');
      throw new Error('first failed');
    });
    const second = withTransaction(handle, async (db) => {
      order.push('second:start');
      await db.insert(categories).values(categoryRow('second'));
      order.push('second:end');
      return db.select().from(categories).where(eq(categories.slug, 'first'));
    });

    await expect(first).rejects.toThrow('first failed');
    expect(await second).toEqual([]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(await slugs(handle)).toEqual(['second']);
  });
});

describe('withTransaction isolation on a shared connection', () => {
  const getHandle = useTestDatabase();

  it('makes a statement issued outside a running transaction wait instead of joining it', async () => {
    const handle = getHandle();
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failing = withTransaction(handle, async (db) => {
      await db.insert(categories).values(categoryRow('inside'));
      order.push('inside');
      await gate;
      throw new Error('rolled back');
    });
    // Let the transaction start, then write from outside it while it is still open.
    await new Promise((resolve) => setImmediate(resolve));
    expect(handle.sqlite.isTransaction).toBe(true);
    const outside = handle.db
      .insert(categories)
      .values(categoryRow('outside'))
      .then(() => order.push('outside'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['inside']);
    release();

    await expect(failing).rejects.toThrow('rolled back');
    await outside;
    expect(order).toEqual(['inside', 'outside']);
    const rows = await handle.db.select({ slug: categories.slug }).from(categories);
    expect(rows.map((row) => row.slug)).toEqual(['outside']);
  });

  /** Yields `count` microtasks: the granularity at which the Drizzle proxy interleaves. */
  async function microtasks(count: number): Promise<void> {
    for (let step = 0; step < count; step += 1) await Promise.resolve();
  }

  async function storedSlugs(handle: DatabaseHandle): Promise<string[]> {
    const rows = await handle.db
      .select({ slug: categories.slug })
      .from(categories)
      .orderBy(categories.slug);
    return rows.map((row) => row.slug);
  }

  /**
   * Starts a Drizzle query now. Query builders are lazy thenables that run again on every `then`,
   * so the test holds the one promise this returns.
   */
  function run(query: PromiseLike<unknown>): Promise<unknown> {
    // `then` is called synchronously: `Promise.resolve(query)` would defer it by one microtask.
    return new Promise((resolve, reject) => {
      query.then(resolve, reject);
    });
  }

  /** A transaction that writes `slug` and then rolls back. */
  function rolledBack(handle: DatabaseHandle, slug: string): Promise<void> {
    return withTransaction(handle, async (db) => {
      await db.insert(categories).values(categoryRow(slug));
      throw new Error('rolled back');
    });
  }

  // Regression (review of PR #44): the proxy awaited its "is a foreign transaction open?" check
  // and only then prepared the statement. A `withTransaction` that began in that microtask
  // swallowed the outside statement, which was then rolled back with it. Every offset is tried,
  // because only some of them hit the gap: with the old proxy, "transaction-first, offset 0" (a
  // statement issued in the same synchronous step that queued the transaction) lost its row.
  it('never lets an outside statement join a transaction that begins right next to it', async () => {
    const handle = getHandle();
    for (let offset = 0; offset <= 30; offset += 1) {
      for (const order of ['outside-first', 'transaction-first'] as const) {
        handle.sqlite.exec('delete from categories');
        const outsideSlug = `outside-${order}-${offset}`;
        let transaction: Promise<void>;
        let outside: Promise<unknown>;
        if (order === 'outside-first') {
          outside = run(handle.db.insert(categories).values(categoryRow(outsideSlug)));
          await microtasks(offset);
          transaction = rolledBack(handle, `inside-${offset}`);
        } else {
          transaction = rolledBack(handle, `inside-${offset}`);
          await microtasks(offset);
          outside = run(handle.db.insert(categories).values(categoryRow(outsideSlug)));
        }
        await expect(transaction).rejects.toThrow('rolled back');
        await outside;
        expect(await storedSlugs(handle), `${order}, offset ${offset}`).toEqual([outsideSlug]);
      }
    }
  });

  it('keeps a waiting statement out of the transaction queued behind the one it waited for', async () => {
    const handle = getHandle();
    for (let offset = 0; offset <= 30; offset += 1) {
      handle.sqlite.exec('delete from categories');
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = withTransaction(handle, async (db) => {
        await db.insert(categories).values(categoryRow('first'));
        await gate;
      });
      await new Promise((resolve) => setImmediate(resolve));
      const outside = run(handle.db.insert(categories).values(categoryRow('outside')));
      await microtasks(offset);
      const second = rolledBack(handle, 'second');
      release();
      await first;
      await expect(second).rejects.toThrow('rolled back');
      await outside;
      expect(await storedSlugs(handle), `offset ${offset}`).toEqual(['first', 'outside']);
    }
  });

  it('treats a callback continuation that outlives its transaction as outside code', async () => {
    const handle = getHandle();
    let leaked: Promise<unknown> = Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withTransaction(handle, async () => {
      // Not awaited: it runs after this transaction committed, while the next one is open.
      leaked = gate.then(() => handle.db.insert(categories).values(categoryRow('leaked')));
    });
    const next = withTransaction(handle, async (db) => {
      await db.insert(categories).values(categoryRow('next'));
      release();
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error('rolled back');
    });
    await expect(next).rejects.toThrow('rolled back');
    await leaked;
    expect(await storedSlugs(handle)).toEqual(['leaked']);
  });

  it('rejects a nested withTransaction instead of deadlocking', async () => {
    const handle = getHandle();
    const result = await withTransaction(handle, async (db) => {
      await db.insert(categories).values(categoryRow('outer'));
      await expect(withTransaction(handle, async () => 'inner')).rejects.toThrow(
        'withTransaction cannot be nested',
      );
      return 'outer done';
    });
    expect(result).toBe('outer done');
    expect(await storedSlugs(handle)).toEqual(['outer']);
  });

  it('does not wait for a transaction opened outside withTransaction', async () => {
    const handle = getHandle();
    handle.sqlite.exec('BEGIN');
    await handle.db.insert(categories).values(categoryRow('raw'));
    handle.sqlite.exec('ROLLBACK');
    expect(await handle.db.$count(categories)).toBe(0);
  });
});

describe('migration 0001_add_job_result', () => {
  /** A migrations folder holding only the first `count` entries of the real journal. */
  function partialMigrations(dir: string, count: number): string {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const entries = journal.entries.slice(0, count);
    const folder = join(dir, `migrations-${count}`);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const { tag } of entries) {
      copyFileSync(join(migrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
    }
    return folder;
  }

  function jobColumns(handle: DatabaseHandle): string[] {
    return handle.sqlite
      .prepare('pragma table_info(jobs)')
      .all()
      .map((row) => String(row.name));
  }

  it('adds a nullable jobs.result to an existing database and can be rolled back', async () => {
    const temp = makeTempDir();
    const before = openDatabase(join(temp.dir, 'before.db'));
    const handle = openDatabase(join(temp.dir, 'data.db'));
    try {
      await migrateDatabase(before, partialMigrations(temp.dir, 1));
      await migrateDatabase(handle, partialMigrations(temp.dir, 1));
      handle.sqlite.exec(
        `insert into jobs (id, type, status, payload, created_at)
         values ('job_old', 'benchmark-run', 'completed', '{"a":1}', '2026-01-01T00:00:00.000Z')`,
      );

      // Up: the existing row survives with a null result.
      expect((await migrateDatabase(handle, migrationsFolder)).applied).toBe(1);
      expect(jobColumns(handle)).toEqual([...jobColumns(before), 'result']);
      expect(
        handle.sqlite.prepare("select payload, result from jobs where id = 'job_old'").get(),
      ).toEqual({ payload: '{"a":1}', result: null });

      // Down (the rollback plan in the PR): drop the column and forget the migration. The
      // table returns to the 0000 shape with its data, and the migration can be applied again.
      handle.sqlite.exec('alter table jobs drop column result');
      handle.sqlite.exec(
        'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)',
      );
      expect(jobColumns(handle)).toEqual(jobColumns(before));
      expect(handle.sqlite.prepare("select payload from jobs where id = 'job_old'").get()).toEqual({
        payload: '{"a":1}',
      });
      expect((await migrateDatabase(handle, migrationsFolder)).applied).toBe(1);
      expect(jobColumns(handle)).toContain('result');
    } finally {
      before.close();
      handle.close();
      temp.dispose();
    }
  });
});

describe('schema', () => {
  const getHandle = useTestDatabase();

  const exports: unknown[] = Object.values(schema);
  const tables = exports.filter((value): value is SQLiteTable => is(value, SQLiteTable));

  it('declares the same foreign keys and indexes as the migrated database', () => {
    const handle = getHandle();
    expect(tables.map((t) => getTableName(t)).sort()).toEqual(
      tableNames(handle).filter((name) => !name.startsWith('__')),
    );
    for (const table of tables) {
      const config = getTableConfig(table);
      const declaredKeys = config.foreignKeys
        .map((fk) => {
          const ref = fk.reference();
          return {
            from: ref.columns.map((c) => c.name).join(','),
            table: getTableName(ref.foreignTable),
            to: ref.foreignColumns.map((c) => c.name).join(','),
            onDelete: (fk.onDelete ?? 'no action').toUpperCase(),
          };
        })
        .sort((a, b) => a.from.localeCompare(b.from));
      const actualKeys = handle.sqlite
        .prepare(`pragma foreign_key_list(${config.name})`)
        .all()
        .map((row) => ({
          from: String(row.from),
          table: String(row.table),
          to: String(row.to),
          onDelete: String(row.on_delete),
        }))
        .sort((a, b) => a.from.localeCompare(b.from));
      expect(declaredKeys, config.name).toEqual(actualKeys);

      const declaredIndexes = config.indexes.map((i) => i.config.name).sort();
      const actualIndexes = handle.sqlite
        .prepare(`pragma index_list(${config.name})`)
        .all()
        .filter((row) => row.origin === 'c')
        .map((row) => String(row.name))
        .sort();
      expect(declaredIndexes, config.name).toEqual(actualIndexes);
    }
  });
});
