import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, getTableName, is, sql } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARTIFACT_FORMAT_TYPES, ARTIFACT_FORMATS } from '@directivebench/core';
import {
  ensureDatabaseDir,
  migrateDatabase,
  openDatabase,
  refreshSourceFields,
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
    nameKey: slug,
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
      expect((await migrateDatabase(handle, migrationsFolder)).applied).toBe(10);
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

/**
 * Timeout for the offset sweeps below: ~20 ms alone, but they run over a hundred statements
 * against a database file on disk, and on the 2-core CI runner shared with every package one sweep
 * exceeded vitest's 5 s default (issue #114). They assert ordering, never time.
 */
const OFFSET_SWEEP_TIMEOUT_MS = 60_000;

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
  it(
    'never lets an outside statement join a transaction that begins right next to it',
    async () => {
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
    },
    OFFSET_SWEEP_TIMEOUT_MS,
  );

  it(
    'keeps a waiting statement out of the transaction queued behind the one it waited for',
    async () => {
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
    },
    OFFSET_SWEEP_TIMEOUT_MS,
  );

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

describe('additive migrations', () => {
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

  function columns(handle: DatabaseHandle, table: string): string[] {
    return handle.sqlite
      .prepare(`pragma table_info(${table})`)
      .all()
      .map((row) => String(row.name));
  }
  const jobColumns = (handle: DatabaseHandle) => columns(handle, 'jobs');

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
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 2))).applied).toBe(1);
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
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 2))).applied).toBe(1);
      expect(jobColumns(handle)).toContain('result');
    } finally {
      before.close();
      handle.close();
      temp.dispose();
    }
  });

  it('adds a nullable benchmark_runs.baseline_artifact_version_id: existing runs read as baseline none (SPEC-118 §8.1)', async () => {
    const temp = makeTempDir();
    const before = openDatabase(join(temp.dir, 'before.db'));
    const handle = openDatabase(join(temp.dir, 'data.db'));
    const runColumns = (h: DatabaseHandle) => columns(h, 'benchmark_runs');
    try {
      await migrateDatabase(before, partialMigrations(temp.dir, 2));
      await migrateDatabase(handle, partialMigrations(temp.dir, 2));
      handle.sqlite.exec(`
        insert into artifacts (id, slug, name, type, created_at, updated_at)
          values ('art_1', 'a', 'A', 'skill', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
          values ('artv_1', 'art_1', 1, 'h', 'skill-md', 'SKILL.md', '[]', '{}', '2026-01-01T00:00:00.000Z');
        insert into benchmark_suites (id, slug, name, created_at, updated_at)
          values ('suite_1', 's', 'S', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        insert into benchmark_suite_versions (id, suite_id, version, schema_version, definition, fixtures, content_hash, created_at)
          values ('suitev_1', 'suite_1', 1, 1, '{}', '{}', 'h', '2026-01-01T00:00:00.000Z');
        insert into benchmark_runs (id, suite_version_id, artifact_version_id, agent_adapter_id, environment, status, started_at)
          values ('run_old', 'suitev_1', 'artv_1', 'mock', '{}', 'completed', '2026-01-01T00:00:00.000Z');
      `);

      // Up: the existing run survives with a null baseline, i.e. baseline kind `none`.
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 3))).applied).toBe(1);
      expect(runColumns(handle)).toEqual([...runColumns(before), 'baseline_artifact_version_id']);
      expect(
        handle.sqlite
          .prepare(
            "select artifact_version_id, baseline_artifact_version_id from benchmark_runs where id = 'run_old'",
          )
          .get(),
      ).toEqual({ artifact_version_id: 'artv_1', baseline_artifact_version_id: null });
      // The new column references artifact_versions.
      expect(() =>
        handle.sqlite.exec(
          "update benchmark_runs set baseline_artifact_version_id = 'artv_missing' where id = 'run_old'",
        ),
      ).toThrow(/FOREIGN KEY/);

      // Down (the rollback plan in the PR): drop the index and the column and forget the
      // migration; the table returns to the 0001 shape with its data.
      handle.sqlite.exec('drop index benchmark_runs_artifact_baseline_idx');
      handle.sqlite.exec('alter table benchmark_runs drop column baseline_artifact_version_id');
      handle.sqlite.exec(
        'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)',
      );
      expect(runColumns(handle)).toEqual(runColumns(before));
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 3))).applied).toBe(1);
      expect(runColumns(handle)).toContain('baseline_artifact_version_id');
    } finally {
      before.close();
      handle.close();
      temp.dispose();
    }
  });

  it('adds agent_runs.output_files_kept/reason and agent_run_files: existing agent runs read as not kept (SPEC-123 §8.1)', async () => {
    const temp = makeTempDir();
    const before = openDatabase(join(temp.dir, 'before.db'));
    const handle = openDatabase(join(temp.dir, 'data.db'));
    const agentRunColumns = (h: DatabaseHandle) => columns(h, 'agent_runs');
    try {
      await migrateDatabase(before, partialMigrations(temp.dir, 3));
      await migrateDatabase(handle, partialMigrations(temp.dir, 3));
      handle.sqlite.exec(`
        insert into artifacts (id, slug, name, type, created_at, updated_at)
          values ('art_1', 'a', 'A', 'skill', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
          values ('artv_1', 'art_1', 1, 'h', 'skill-md', 'SKILL.md', '[]', '{}', '2026-01-01T00:00:00.000Z');
        insert into benchmark_suites (id, slug, name, created_at, updated_at)
          values ('suite_1', 's', 'S', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        insert into benchmark_suite_versions (id, suite_id, version, schema_version, definition, fixtures, content_hash, created_at)
          values ('suitev_1', 'suite_1', 1, 1, '{}', '{}', 'h', '2026-01-01T00:00:00.000Z');
        insert into benchmark_runs (id, suite_version_id, artifact_version_id, agent_adapter_id, environment, status, started_at)
          values ('run_old', 'suitev_1', 'artv_1', 'mock', '{}', 'completed', '2026-01-01T00:00:00.000Z');
        insert into agent_runs (id, benchmark_run_id, case_id, variant, repetition, fixture_version_id, execution_status, duration_ms, changed_files, trace, created_at)
          values ('arun_old', 'run_old', 'c', 'baseline', 1, 'f', 'completed', 1, '[]', '[]', '2026-01-01T00:00:00.000Z');
      `);

      // Up: the existing agent run survives and reads as "not kept" with no reason.
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 4))).applied).toBe(1);
      expect(agentRunColumns(handle)).toEqual([
        ...agentRunColumns(before),
        'output_files_kept',
        'output_files_reason',
      ]);
      expect(
        handle.sqlite
          .prepare(
            "select output_files_kept, output_files_reason from agent_runs where id = 'arun_old'",
          )
          .get(),
      ).toEqual({ output_files_kept: 0, output_files_reason: null });
      handle.sqlite.exec(`
        insert into agent_run_files (id, agent_run_id, path, change, kept)
          values ('afile_1', 'arun_old', 'a.txt', 'deleted', 'none');
      `);
      expect(
        handle.sqlite
          .prepare(
            "select stored_bytes, redactions, content from agent_run_files where id = 'afile_1'",
          )
          .get(),
      ).toEqual({ stored_bytes: 0, redactions: 0, content: null });
      expect(() =>
        handle.sqlite.exec(
          "insert into agent_run_files (id, agent_run_id, path, change, kept) values ('afile_2', 'arun_missing', 'b', 'added', 'none')",
        ),
      ).toThrow(/FOREIGN KEY/);

      // Down (the rollback plan in the PR): drop the new table and columns and forget the
      // migration; agent_runs returns to the 0002 shape with its data and the migration re-applies.
      handle.sqlite.exec('drop table agent_run_files');
      handle.sqlite.exec('alter table agent_runs drop column output_files_reason');
      handle.sqlite.exec('alter table agent_runs drop column output_files_kept');
      handle.sqlite.exec(
        'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)',
      );
      expect(agentRunColumns(handle)).toEqual(agentRunColumns(before));
      expect(tableNames(handle)).not.toContain('agent_run_files');
      expect(
        handle.sqlite.prepare("select case_id from agent_runs where id = 'arun_old'").get(),
      ).toEqual({ case_id: 'c' });
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 4))).applied).toBe(1);
      expect(tableNames(handle)).toContain('agent_run_files');
    } finally {
      before.close();
      handle.close();
      temp.dispose();
    }
  });

  it('adds blind_reviews and blind_review_pairs with cascades and checks, and can be rolled back (SPEC-123 §8.1)', async () => {
    const temp = makeTempDir();
    const before = openDatabase(join(temp.dir, 'before.db'));
    const handle = openDatabase(join(temp.dir, 'data.db'));
    try {
      await migrateDatabase(before, partialMigrations(temp.dir, 4));
      await migrateDatabase(handle, partialMigrations(temp.dir, 4));
      handle.sqlite.exec(`
        insert into artifacts (id, slug, name, type, created_at, updated_at)
          values ('art_1', 'a', 'A', 'skill', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
          values ('artv_1', 'art_1', 1, 'h', 'skill-md', 'SKILL.md', '[]', '{}', '2026-01-01T00:00:00.000Z');
        insert into benchmark_suites (id, slug, name, created_at, updated_at)
          values ('suite_1', 's', 'S', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        insert into benchmark_suite_versions (id, suite_id, version, schema_version, definition, fixtures, content_hash, created_at)
          values ('suitev_1', 'suite_1', 1, 1, '{}', '{}', 'h', '2026-01-01T00:00:00.000Z');
        insert into benchmark_runs (id, suite_version_id, artifact_version_id, agent_adapter_id, environment, status, started_at)
          values ('run_old', 'suitev_1', 'artv_1', 'mock', '{}', 'completed', '2026-01-01T00:00:00.000Z');
        insert into agent_runs (id, benchmark_run_id, case_id, variant, repetition, fixture_version_id, execution_status, duration_ms, changed_files, trace, created_at, output_files_kept)
          values ('arun_b', 'run_old', 'c', 'baseline', 1, 'f', 'completed', 1, '[]', '[]', '2026-01-01T00:00:00.000Z', 1),
                 ('arun_c', 'run_old', 'c', 'candidate', 1, 'f', 'completed', 1, '[]', '[]', '2026-01-01T00:00:00.000Z', 1);
      `);

      // Up: the two tables appear; existing tables and rows are untouched.
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 5))).applied).toBe(1);
      expect(tableNames(handle)).toEqual(
        [...tableNames(before), 'blind_review_pairs', 'blind_reviews'].sort(),
      );
      expect(columns(handle, 'agent_runs')).toEqual(columns(before, 'agent_runs'));
      handle.sqlite.exec(`
        insert into blind_reviews (id, benchmark_run_id, created_at)
          values ('brev_1', 'run_old', '2026-01-01T00:00:00.000Z');
        insert into blind_review_pairs (id, review_id, position, case_id, a_agent_run_id, b_agent_run_id)
          values ('bpair_1', 'brev_1', 1, 'c', 'arun_c', 'arun_b');
      `);
      expect(
        handle.sqlite
          .prepare(
            "select revealed_at, verdict, note, decided_at from blind_review_pairs join blind_reviews on blind_reviews.id = review_id where blind_review_pairs.id = 'bpair_1'",
          )
          .get(),
      ).toEqual({ revealed_at: null, verdict: null, note: null, decided_at: null });
      // One review per run (A10), one pair per position, two different sides, a known verdict.
      expect(() =>
        handle.sqlite.exec(
          "insert into blind_reviews (id, benchmark_run_id, created_at) values ('brev_2', 'run_old', 'x')",
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        handle.sqlite.exec(
          "insert into blind_review_pairs (id, review_id, position, case_id, a_agent_run_id, b_agent_run_id) values ('bpair_2', 'brev_1', 1, 'c', 'arun_b', 'arun_c')",
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        handle.sqlite.exec(
          "insert into blind_review_pairs (id, review_id, position, case_id, a_agent_run_id, b_agent_run_id) values ('bpair_3', 'brev_1', 2, 'c', 'arun_b', 'arun_b')",
        ),
      ).toThrow(/CHECK constraint failed: blind_review_pairs_sides_differ/);
      expect(() =>
        handle.sqlite.exec(
          "update blind_review_pairs set verdict = 'baseline' where id = 'bpair_1'",
        ),
      ).toThrow(/CHECK constraint failed: blind_review_pairs_verdict_known/);
      expect(() =>
        handle.sqlite.exec(
          "insert into blind_review_pairs (id, review_id, position, case_id, a_agent_run_id, b_agent_run_id) values ('bpair_4', 'brev_1', 2, 'c', 'arun_b', 'arun_missing')",
        ),
      ).toThrow(/FOREIGN KEY/);

      // Cascade: removing an agent run removes its pair; removing the run removes the review.
      handle.sqlite.exec("delete from agent_runs where id = 'arun_b'");
      expect(handle.sqlite.prepare('select count(*) as n from blind_review_pairs').get()).toEqual({
        n: 0,
      });
      handle.sqlite.exec("delete from benchmark_runs where id = 'run_old'");
      expect(handle.sqlite.prepare('select count(*) as n from blind_reviews').get()).toEqual({
        n: 0,
      });

      // Down (the rollback plan in the PR): drop both tables and forget the migration; the
      // database returns to the 0003 shape and the migration re-applies.
      handle.sqlite.exec('drop table blind_review_pairs');
      handle.sqlite.exec('drop table blind_reviews');
      handle.sqlite.exec(
        'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)',
      );
      expect(tableNames(handle)).toEqual(tableNames(before));
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 5))).applied).toBe(1);
      expect(tableNames(handle)).toContain('blind_review_pairs');
    } finally {
      before.close();
      handle.close();
      temp.dispose();
    }
  });

  it('adds categories.name_key backfilled on a 0004 database with a partial unique index, and can be rolled back (SPEC-124 §8.1)', async () => {
    const temp = makeTempDir();
    const handle = openDatabase(join(temp.dir, 'data.db'));
    try {
      await migrateDatabase(handle, partialMigrations(temp.dir, 5));
      // What a 0004 database holds: predefined categories (one archived) and an assignment.
      handle.sqlite.exec(`
        insert into categories (id, slug, name, description, predefined, archived_at, created_at, updated_at) values
          ('cat_sec', 'security', 'Security', 'S', 1, null, 't', 't'),
          ('cat_ops', 'devops', ' DevOps ', null, 1, null, 't', 't'),
          ('cat_py', 'python', 'Python', null, 1, 't', 't', 't');
        insert into artifacts (id, slug, name, type, created_at, updated_at)
          values ('art_1', 'a', 'A', 'skill', 't', 't');
        insert into artifact_categories (artifact_id, category_id, created_at)
          values ('art_1', 'cat_sec', 't');
      `);

      // Up: every row gets its key, nothing keeps the column default, rows and links survive.
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 6))).applied).toBe(1);
      expect(
        handle.sqlite
          .prepare('select id, name, name_key, archived_at from categories order by id')
          .all(),
      ).toEqual([
        { id: 'cat_ops', name: ' DevOps ', name_key: 'devops', archived_at: null },
        { id: 'cat_py', name: 'Python', name_key: 'python', archived_at: 't' },
        { id: 'cat_sec', name: 'Security', name_key: 'security', archived_at: null },
      ]);
      expect(
        handle.sqlite.prepare("select count(*) as n from categories where name_key = ''").get(),
      ).toEqual({ n: 0 });
      expect(handle.sqlite.prepare('select count(*) as n from artifact_categories').get()).toEqual({
        n: 1,
      });

      // The partial index: a second active row with the same key is refused, an archived one
      // is not, and unarchiving into a clash is refused too (AC-9).
      expect(() =>
        handle.sqlite.exec(
          "insert into categories (id, slug, name, name_key, created_at, updated_at) values ('cat_x', 'security-2', 'SECURITY', 'security', 't', 't')",
        ),
      ).toThrow(/UNIQUE constraint failed: categories.name_key/);
      handle.sqlite.exec(
        "insert into categories (id, slug, name, name_key, archived_at, created_at, updated_at) values ('cat_y', 'python-2', 'python', 'python', 't', 't', 't')",
      );
      handle.sqlite.exec(
        "insert into categories (id, slug, name, name_key, created_at, updated_at) values ('cat_z', 'python-3', 'Python', 'python', 't', 't')",
      );
      expect(() =>
        handle.sqlite.exec("update categories set archived_at = null where id = 'cat_py'"),
      ).toThrow(/UNIQUE constraint failed: categories.name_key/);

      // Down (the rollback plan in the PR): drop the index and the column and forget the
      // migration; the table returns to the 0004 shape and the migration re-applies.
      handle.sqlite.exec("delete from categories where id in ('cat_y', 'cat_z')");
      handle.sqlite.exec('drop index categories_active_name_key_unique');
      handle.sqlite.exec('alter table categories drop column name_key');
      handle.sqlite.exec(
        'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)',
      );
      expect(
        handle.sqlite
          .prepare('pragma table_info(categories)')
          .all()
          .map((row) => String(row.name)),
      ).not.toContain('name_key');
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 6))).applied).toBe(1);
      expect(
        handle.sqlite.prepare("select name_key from categories where id = 'cat_sec'").get(),
      ).toEqual({ name_key: 'security' });
    } finally {
      handle.close();
      temp.dispose();
    }
  });

  it('adds artifact_versions.parent_version_id and the identity indexes on a 0005 database, and can be rolled back (SPEC-126 §8.1)', async () => {
    const temp = makeTempDir();
    const handle = openDatabase(join(temp.dir, 'data.db'));
    const indexNames = () =>
      handle.sqlite
        .prepare(
          "select name from sqlite_master where type = 'index' and name like '%_idx' order by name",
        )
        .all()
        .map((row) => String(row.name));
    try {
      await migrateDatabase(handle, partialMigrations(temp.dir, 6));
      const before = indexNames();
      handle.sqlite.exec(`
        insert into repositories (id, provider, name, location, created_at, updated_at)
          values ('repo_1', 'local-directory', 'r', '/r', 't', 't');
        insert into artifacts (id, slug, name, type, created_at, updated_at)
          values ('art_1', 'a', 'A', 'skill', 't', 't');
        insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
          values ('artv_1', 'art_1', 1, 'h1', 'skill-md', 'SKILL.md', '[]', '{}', 't'),
                 ('artv_2', 'art_1', 2, 'h2', 'skill-md', 'SKILL.md', '[]', '{}', 't');
      `);

      // Up: existing versions keep a null parent; the three indexes exist.
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 7))).applied).toBe(1);
      expect(
        handle.sqlite
          .prepare('select id, parent_version_id from artifact_versions order by id')
          .all(),
      ).toEqual([
        { id: 'artv_1', parent_version_id: null },
        { id: 'artv_2', parent_version_id: null },
      ]);
      expect(indexNames()).toEqual(
        [
          ...before,
          'artifact_occurrences_artifact_idx',
          'artifact_versions_content_hash_idx',
          'artifacts_type_name_idx',
        ].sort(),
      );
      // The parent is a foreign key that becomes null when its version is deleted.
      handle.sqlite.exec(
        "insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, parent_version_id, created_at) values ('artv_3', 'art_1', 3, 'h3', 'skill-md', 'SKILL.md', '[]', '{}', 'artv_2', 't')",
      );
      expect(() =>
        handle.sqlite.exec(
          "insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, parent_version_id, created_at) values ('artv_4', 'art_1', 4, 'h4', 'skill-md', 'SKILL.md', '[]', '{}', 'artv_none', 't')",
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
      handle.sqlite.exec("delete from artifact_versions where id = 'artv_2'");
      expect(
        handle.sqlite
          .prepare("select parent_version_id from artifact_versions where id = 'artv_3'")
          .get(),
      ).toEqual({ parent_version_id: null });

      // Down (the rollback plan in the PR): drop the indexes, then the column (a REFERENCES
      // column), and forget the migration; it re-applies.
      handle.sqlite.exec('drop index artifact_versions_content_hash_idx');
      handle.sqlite.exec('drop index artifact_occurrences_artifact_idx');
      handle.sqlite.exec('drop index artifacts_type_name_idx');
      handle.sqlite.exec('alter table artifact_versions drop column parent_version_id');
      handle.sqlite.exec(
        'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)',
      );
      expect(indexNames()).toEqual(before);
      expect(
        handle.sqlite
          .prepare('pragma table_info(artifact_versions)')
          .all()
          .map((row) => String(row.name)),
      ).not.toContain('parent_version_id');
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 7))).applied).toBe(1);
      expect(
        handle.sqlite
          .prepare("select parent_version_id from artifact_versions where id = 'artv_3'")
          .get(),
      ).toEqual({ parent_version_id: null });
    } finally {
      handle.close();
      temp.dispose();
    }
  });

  it('repairs stale artifact types from the chosen active occurrence on a 0006 database, and can be re-applied (issue 66)', async () => {
    const temp = makeTempDir();
    const handle = openDatabase(join(temp.dir, 'data.db'));
    const types = () =>
      Object.fromEntries(
        handle.sqlite
          .prepare('select id, type, updated_at from artifacts order by id')
          .all()
          .map((row) => [String(row.id), [String(row.type), String(row.updated_at)]]),
      );
    try {
      await migrateDatabase(handle, partialMigrations(temp.dir, 7));
      const insertVersion = handle.sqlite.prepare(
        "insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at) values (?, ?, ?, ?, ?, 'x', '[]', '{}', 't')",
      );
      const insertOccurrence = handle.sqlite.prepare(
        "insert into artifact_occurrences (id, artifact_id, repository_id, path, latest_version_id, status, last_seen_at, created_at, updated_at) values (?, ?, 'repo_1', ?, ?, ?, 't', ?, 't')",
      );
      const insertArtifact = handle.sqlite.prepare(
        "insert into artifacts (id, slug, name, type, created_at, updated_at) values (?, ?, ?, ?, 't', 'old')",
      );
      handle.sqlite.exec(
        "insert into repositories (id, provider, name, location, created_at, updated_at) values ('repo_1', 'local-directory', 'r', '/r', 't', 't')",
      );
      // One stale artifact per format: an instruction-typed row whose only version has that format.
      for (const format of ARTIFACT_FORMATS) {
        const id = `art_${format}`;
        insertArtifact.run(
          id,
          format,
          format,
          ARTIFACT_FORMAT_TYPES[format] === 'skill' ? 'rule' : 'skill',
        );
        insertVersion.run(`artv_${format}`, id, 1, `h_${format}`, format);
        insertOccurrence.run(`occ_${format}`, id, `p/${format}`, `artv_${format}`, 'active', 't');
      }
      // (b3): v1 agents-md, v2 skill-md at the same path; still typed instruction.
      insertArtifact.run('art_b3', 'b3', 'b3', 'instruction');
      insertVersion.run('artv_b3_1', 'art_b3', 1, 'h1', 'agents-md');
      insertVersion.run('artv_b3_2', 'art_b3', 2, 'h2', 'skill-md');
      insertOccurrence.run('occ_b3', 'art_b3', 'docs/AGENTS.md', 'artv_b3_2', 'active', 't');
      // Already correct: untouched, `updated_at` kept.
      insertArtifact.run('art_ok', 'ok', 'ok', 'rule');
      insertVersion.run('artv_ok', 'art_ok', 1, 'h', 'cursor-rule');
      insertOccurrence.run('occ_ok', 'art_ok', '.cursor/rules/ok.mdc', 'artv_ok', 'active', 't');
      // Missing (no active occurrence): keeps its type.
      insertArtifact.run('art_gone', 'gone', 'gone', 'instruction');
      insertVersion.run('artv_gone', 'art_gone', 1, 'h', 'skill-md');
      insertOccurrence.run('occ_gone', 'art_gone', 'skills/gone', 'artv_gone', 'removed', 't');
      // The active occurrence holds v1 (rule); a newer v2 (skill) is held only by a removed one.
      insertArtifact.run('art_old', 'old', 'old', 'skill');
      insertVersion.run('artv_old_1', 'art_old', 1, 'h1', 'cursor-rule');
      insertVersion.run('artv_old_2', 'art_old', 2, 'h2', 'skill-md');
      insertOccurrence.run(
        'occ_old_a',
        'art_old',
        '.cursor/rules/old.mdc',
        'artv_old_1',
        'active',
        't',
      );
      insertOccurrence.run('occ_old_b', 'art_old', 'skills/old', 'artv_old_2', 'removed', 't');
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 8))).applied).toBe(1);
      const after = types();
      for (const format of ARTIFACT_FORMATS) {
        expect(after[`art_${format}`]?.[0], format).toBe(ARTIFACT_FORMAT_TYPES[format]);
        expect(after[`art_${format}`]?.[1]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      }
      expect(after.art_b3?.[0]).toBe('skill');
      expect(after.art_ok).toEqual(['rule', 'old']);
      expect(after.art_gone).toEqual(['instruction', 'old']);
      expect(after.art_old?.[0]).toBe('rule');

      // The runtime refresh makes the same choice for every row: it changes nothing more.
      await withTransaction(handle, (db) => refreshSourceFields(db, Object.keys(after)));
      expect(Object.fromEntries(Object.entries(types()).map(([id, [type]]) => [id, type]))).toEqual(
        Object.fromEntries(Object.entries(after).map(([id, [type]]) => [id, type])),
      );

      // Down: a data-only migration has nothing to undo (the old type was stale by definition);
      // forgetting it and applying it again changes nothing.
      handle.sqlite.exec(
        'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)',
      );
      const before = types();
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 8))).applied).toBe(1);
      expect(types()).toEqual(before);
    } finally {
      handle.close();
      temp.dispose();
    }
  });

  it('adds a nullable repositories.scanned_branch on a 0007 database, and can be rolled back and re-applied (issue 58)', async () => {
    const temp = makeTempDir();
    const before = openDatabase(join(temp.dir, 'before.db'));
    const handle = openDatabase(join(temp.dir, 'data.db'));
    const row = () =>
      handle.sqlite
        .prepare("select selected_branch, last_commit_sha from repositories where id = 'repo_gh'")
        .get();
    try {
      await migrateDatabase(before, partialMigrations(temp.dir, 8));
      await migrateDatabase(handle, partialMigrations(temp.dir, 8));
      handle.sqlite.exec(
        `insert into repositories (id, provider, name, location, default_branch, selected_branch, last_commit_sha, sync_status, created_at, updated_at)
         values ('repo_gh', 'github', 'a/b', 'https://github.com/a/b', 'main', 'dev', '${'a'.repeat(40)}', 'ok', 't', 't')`,
      );

      // Up: the existing row keeps its values and reads an unknown scanned branch.
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 9))).applied).toBe(1);
      expect(columns(handle, 'repositories')).toEqual([
        ...columns(before, 'repositories'),
        'scanned_branch',
      ]);
      expect(
        handle.sqlite.prepare("select scanned_branch from repositories where id = 'repo_gh'").get(),
      ).toEqual({ scanned_branch: null });
      expect(row()).toEqual({ selected_branch: 'dev', last_commit_sha: 'a'.repeat(40) });

      // Down: drop the column and forget the migration; the data stays, and it applies again.
      handle.sqlite.exec('alter table repositories drop column scanned_branch');
      handle.sqlite.exec(
        'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)',
      );
      expect(columns(handle, 'repositories')).toEqual(columns(before, 'repositories'));
      expect(row()).toEqual({ selected_branch: 'dev', last_commit_sha: 'a'.repeat(40) });
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 9))).applied).toBe(1);
      expect(columns(handle, 'repositories')).toContain('scanned_branch');
      // Re-applying everything is a no-op.
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 9))).applied).toBe(0);
    } finally {
      before.close();
      handle.close();
      temp.dispose();
    }
  });

  it('adds artifacts.format backfilled from the chosen version on a 0008 database, with its index, and can be rolled back (issue 246)', async () => {
    const temp = makeTempDir();
    const before = openDatabase(join(temp.dir, 'before.db'));
    const handle = openDatabase(join(temp.dir, 'data.db'));
    const formats = () =>
      Object.fromEntries(
        handle.sqlite
          .prepare('select id, format, updated_at from artifacts order by id')
          .all()
          .map((row) => [String(row.id), [row.format, String(row.updated_at)]]),
      );
    try {
      await migrateDatabase(before, partialMigrations(temp.dir, 9));
      await migrateDatabase(handle, partialMigrations(temp.dir, 9));
      const insertVersion = handle.sqlite.prepare(
        "insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at) values (?, ?, ?, ?, ?, 'x', '[]', '{}', 't')",
      );
      const insertOccurrence = handle.sqlite.prepare(
        "insert into artifact_occurrences (id, artifact_id, repository_id, path, latest_version_id, status, last_seen_at, created_at, updated_at) values (?, ?, 'repo_1', ?, ?, ?, 't', 't', 't')",
      );
      const insertArtifact = handle.sqlite.prepare(
        "insert into artifacts (id, slug, name, type, created_at, updated_at) values (?, ?, ?, ?, 't', 'old')",
      );
      handle.sqlite.exec(
        "insert into repositories (id, provider, name, location, created_at, updated_at) values ('repo_1', 'local-directory', 'r', '/r', 't', 't')",
      );
      // (1) The chosen active occurrence's version, for every format.
      for (const format of ARTIFACT_FORMATS) {
        const id = `art_${format}`;
        insertArtifact.run(id, format, format, ARTIFACT_FORMAT_TYPES[format]);
        insertVersion.run(`artv_${format}`, id, 1, `h_${format}`, format);
        insertOccurrence.run(`occ_${format}`, id, `p/${format}`, `artv_${format}`, 'active');
      }
      // (1) A revert: the active occurrence holds v1 (a cursor rule), the latest is v2 (a skill).
      insertArtifact.run('art_rev', 'rev', 'rev', 'rule');
      insertVersion.run('artv_rev_1', 'art_rev', 1, 'h1', 'cursor-rule');
      insertVersion.run('artv_rev_2', 'art_rev', 2, 'h2', 'skill-md');
      insertOccurrence.run('occ_rev', 'art_rev', '.cursor/rules/rev.mdc', 'artv_rev_1', 'active');
      // (1) The highest version held by an active occurrence wins over a removed one's higher one.
      insertArtifact.run('art_two', 'two', 'two', 'skill');
      insertVersion.run('artv_two_1', 'art_two', 1, 'h1', 'cursor-rule');
      insertVersion.run('artv_two_2', 'art_two', 2, 'h2', 'skill-md');
      insertVersion.run('artv_two_3', 'art_two', 3, 'h3', 'agents-md');
      insertOccurrence.run('occ_two_a', 'art_two', '.cursor/rules/two.mdc', 'artv_two_1', 'active');
      insertOccurrence.run('occ_two_b', 'art_two', 'skills/two', 'artv_two_2', 'active');
      insertOccurrence.run('occ_two_c', 'art_two', 'AGENTS.md', 'artv_two_3', 'removed');
      // (2) Missing: the highest version whose format's type is the artifact's type.
      insertArtifact.run('art_gone', 'gone', 'gone', 'skill');
      insertVersion.run('artv_gone_1', 'art_gone', 1, 'h1', 'cursor-rule');
      insertVersion.run('artv_gone_2', 'art_gone', 2, 'h2', 'skill-md');
      insertVersion.run('artv_gone_3', 'art_gone', 3, 'h3', 'agents-md');
      insertOccurrence.run('occ_gone', 'art_gone', 'skills/gone', 'artv_gone_2', 'removed');
      // (2) No occurrence at all (a raw-SQL seed): its version's format.
      insertArtifact.run('art_seed', 'seed', 'seed', 'skill');
      insertVersion.run('artv_seed', 'art_seed', 1, 'h', 'skill-md');
      // (2) No version of its type: the latest version.
      insertArtifact.run('art_stale', 'stale', 'stale', 'instruction');
      insertVersion.run('artv_stale_1', 'art_stale', 1, 'h1', 'skill-md');
      insertVersion.run('artv_stale_2', 'art_stale', 2, 'h2', 'cursor-rule');
      // (3) No version: stays null.
      insertArtifact.run('art_bare', 'bare', 'bare', 'skill');

      // Up: the column, its backfill and the index; nothing else changes.
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 10))).applied).toBe(1);
      expect(columns(handle, 'artifacts')).toEqual([...columns(before, 'artifacts'), 'format']);
      const after = formats();
      for (const format of ARTIFACT_FORMATS) expect(after[`art_${format}`]).toEqual([format, 'old']);
      expect(after.art_rev).toEqual(['cursor-rule', 'old']);
      expect(after.art_two).toEqual(['skill-md', 'old']);
      expect(after.art_gone).toEqual(['skill-md', 'old']);
      expect(after.art_seed).toEqual(['skill-md', 'old']);
      expect(after.art_stale).toEqual(['cursor-rule', 'old']);
      expect(after.art_bare).toEqual([null, 'old']);
      expect(
        handle.sqlite
          .prepare("select name from pragma_index_info('artifacts_format_name_idx') order by seqno")
          .all(),
      ).toEqual([{ name: 'format' }, { name: 'name' }]);

      // The runtime refresh makes the same choice for every row with an active occurrence.
      await withTransaction(handle, (db) => refreshSourceFields(db, Object.keys(after)));
      expect(Object.fromEntries(Object.entries(formats()).map(([id, [format]]) => [id, format]))).toEqual(
        Object.fromEntries(Object.entries(after).map(([id, [format]]) => [id, format])),
      );

      // Down: drop the index and the column, forget the migration; it applies again.
      handle.sqlite.exec('drop index artifacts_format_name_idx');
      handle.sqlite.exec('alter table artifacts drop column format');
      handle.sqlite.exec(
        'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)',
      );
      expect(columns(handle, 'artifacts')).toEqual(columns(before, 'artifacts'));
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 10))).applied).toBe(1);
      expect(Object.fromEntries(Object.entries(formats()).map(([id, [format]]) => [id, format]))).toEqual(
        Object.fromEntries(Object.entries(after).map(([id, [format]]) => [id, format])),
      );
      expect((await migrateDatabase(handle, partialMigrations(temp.dir, 10))).applied).toBe(0);
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
