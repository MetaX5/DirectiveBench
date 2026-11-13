import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createId } from '@directivebench/core';
import {
  enqueueRepositoryScanJob,
  migrateDatabase,
  openDatabase,
  registerHostedRepository,
  type DatabaseHandle,
} from '@directivebench/database';
import {
  REPOSITORY_CACHE_NAME,
  REPOSITORY_ID,
  listRepositoryCaches,
  sweepOrphanedCaches,
  type RunnerLogFields,
} from '../src/index';

// The file-system functions stay real; a test makes one of them fail where real permissions
// cannot (lesson 2026-10-21).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual, lstat: vi.fn(actual.lstat), rm: vi.fn(actual.rm) };
});

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const posixOnly = it.skipIf(process.platform === 'win32');
// Root ignores directory permissions, so a read-only directory cannot make anything fail.
const unprivilegedPosixOnly = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);

let handle: DatabaseHandle;
/** Everything a test creates lives below this directory, removed after each test. */
let base: string;
let dataDir: string;
let logs: { level: 'info' | 'error'; message: string; fields: RunnerLogFields | undefined }[];
let reportedFailures: Set<string>;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-hosted-cache-')));
  dataDir = join(base, 'data');
  mkdirSync(dataDir);
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
  logs = [];
  reportedFailures = new Set();
});

afterEach(() => {
  vi.clearAllMocks();
  handle.close();
  const repos = join(dataDir, 'cache', 'repos');
  if (existsSync(repos)) chmodSync(repos, 0o700);
  rmSync(base, { recursive: true, force: true });
});

const cacheDir = () => join(dataDir, 'cache');
const reposDir = () => join(cacheDir(), 'repos');
const cacheOf = (id: string) => join(reposDir(), `${id}.git`);

/** A cache directory with a file inside, as a clone leaves it. */
function plantCache(id: string): string {
  const dir = cacheOf(id);
  mkdirSync(join(dir, 'objects'), { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

async function registered(): Promise<string> {
  const { repository } = await registerHostedRepository(handle.db, {
    provider: 'github',
    name: 'rules',
    location: `https://github.com/acme/rules-${createId('x').slice(2, 8)}`,
    defaultBranch: 'main',
  });
  return repository.id;
}

function sweep(options: { handle?: DatabaseHandle; cacheDir?: string } = {}) {
  return sweepOrphanedCaches({
    handle: options.handle ?? handle,
    cacheDir: options.cacheDir ?? cacheDir(),
    reportedFailures,
    logger: {
      info: (message, fields) => logs.push({ level: 'info', message, fields }),
      error: (message, fields) => logs.push({ level: 'error', message, fields }),
    },
  });
}

const events = () => logs.map(({ fields }) => fields);

describe('repository id and cache name (issue 59 J6)', () => {
  it('accept exactly the ids createId produces', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = createId('repo');
      expect(REPOSITORY_ID.test(id)).toBe(true);
      expect(REPOSITORY_CACHE_NAME.exec(`${id}.git`)?.[1]).toBe(id);
    }
    for (const id of ['repo-1', 'repo_1', 'repo_abcdefghijklmnop1', 'xrepo_abcdefghijklmnop']) {
      expect(REPOSITORY_ID.test(id)).toBe(false);
    }
    for (const name of [
      'repo_abcdefghijklmno.git',
      'repo_abcdefghijklmnop',
      'repo_a/cdefghijklmnop.git',
    ]) {
      expect(REPOSITORY_CACHE_NAME.test(name)).toBe(false);
    }
  });
});

describe('sweepOrphanedCaches (SPEC-105 FR-105-19, issue 59)', () => {
  it('deletes the cache of a removed repository and keeps a live one', async () => {
    const live = await registered();
    const orphan = createId('repo');
    plantCache(live);
    plantCache(orphan);
    await sweep();
    expect(existsSync(cacheOf(live))).toBe(true);
    expect(existsSync(cacheOf(orphan))).toBe(false);
    expect(logs).toEqual([
      {
        level: 'info',
        message: `Deleted the cached download of removed repository ${orphan}`,
        fields: { event: 'cache-deleted', repositoryId: orphan },
      },
    ]);
    // Nothing left to do: a second sweep logs nothing.
    await sweep();
    expect(logs).toHaveLength(1);
  });

  it('keeps an orphan while a scan of its id is pending, and deletes it once the job ended', async () => {
    const id = await registered();
    plantCache(id);
    const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: id });
    handle.sqlite.prepare('delete from repositories where id = ?').run(id);
    await sweep();
    expect(existsSync(cacheOf(id))).toBe(true);
    handle.sqlite.prepare(`update jobs set status = 'failed' where id = ?`).run(job.id);
    await sweep();
    expect(existsSync(cacheOf(id))).toBe(false);
  });

  posixOnly('never touches what DirectiveBench did not create', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    const linked = createId('repo');
    const file = createId('repo');
    mkdirSync(reposDir(), { recursive: true });
    mkdirSync(join(cacheDir(), 'git-home'));
    symlinkSync(outside, cacheOf(linked));
    writeFileSync(cacheOf(file), 'not a directory');
    const others = [
      'repo_short.git',
      `${createId('repo')}x.git`,
      createId('repo'),
      `${createId('repo')}.git.bak`,
      'notes.txt',
    ];
    for (const name of others) mkdirSync(join(reposDir(), name));
    await sweep();
    expect(logs).toEqual([]);
    expect(readlinkSync(cacheOf(linked))).toBe(outside);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(existsSync(cacheOf(file))).toBe(true);
    expect(existsSync(join(cacheDir(), 'git-home'))).toBe(true);
    for (const name of others) expect(existsSync(join(reposDir(), name))).toBe(true);
    expect(await listRepositoryCaches(cacheDir())).toEqual({
      root: reposDir(),
      caches: [],
      unknown: [...others, `${linked}.git`, `${file}.git`].sort(),
    });
  });

  posixOnly('removes a link inside an orphan as a link, never its target', async () => {
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'deep'), { recursive: true });
    writeFileSync(join(outside, 'deep', 'keep.txt'), 'keep');
    const orphan = createId('repo');
    const dir = plantCache(orphan);
    symlinkSync(outside, join(dir, 'objects', 'escape'));
    symlinkSync(join(outside, 'deep', 'keep.txt'), join(dir, 'file-link'));
    await sweep();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(outside, 'deep', 'keep.txt'))).toBe(true);
  });

  posixOnly('works when the data directory is reached through a symlink', async () => {
    const link = join(base, 'data-link');
    symlinkSync(dataDir, link);
    const orphan = createId('repo');
    plantCache(orphan);
    await sweep({ cacheDir: join(link, 'cache') });
    expect(existsSync(cacheOf(orphan))).toBe(false);
    expect(events()).toEqual([{ event: 'cache-deleted', repositoryId: orphan }]);
  });

  it('does nothing without a repos directory', async () => {
    await sweep();
    expect(logs).toEqual([]);
    expect(await listRepositoryCaches(cacheDir())).toBeNull();
  });

  it('logs cache-sweep-failed when repos is not a directory', async () => {
    mkdirSync(cacheDir());
    writeFileSync(reposDir(), 'a file');
    await sweep();
    expect(logs).toEqual([
      {
        level: 'error',
        message: 'The sweep of cached GitHub downloads failed (ENOTDIR)',
        fields: { event: 'cache-sweep-failed', code: 'ENOTDIR' },
      },
    ]);
  });

  posixOnly('logs cache-sweep-failed when the repos root cannot be resolved', async () => {
    mkdirSync(cacheDir());
    symlinkSync(reposDir(), reposDir());
    await sweep();
    expect(events()).toEqual([{ event: 'cache-sweep-failed', code: 'ELOOP' }]);
  });

  it('logs cache-sweep-failed with the SQLite code when the database read fails', async () => {
    plantCache(createId('repo'));
    handle.sqlite.exec('ALTER TABLE jobs RENAME TO jobs_gone');
    await sweep();
    expect(events()).toEqual([{ event: 'cache-sweep-failed', code: 'ERR_SQLITE_ERROR' }]);
  });

  unprivilegedPosixOnly(
    'logs a failed deletion once, retries quietly and logs the later success',
    async () => {
      const orphan = createId('repo');
      plantCache(orphan);
      // A read-only parent: the cache cannot be unlinked, and the sweep never repairs `repos`.
      chmodSync(reposDir(), 0o500);
      await sweep();
      await sweep();
      expect(existsSync(cacheOf(orphan))).toBe(true);
      expect(logs).toEqual([
        {
          level: 'error',
          message: `The cached download of removed repository ${orphan} could not be deleted (EACCES); it is retried at the next sweep`,
          fields: { event: 'cache-delete-failed', repositoryId: orphan, code: 'EACCES' },
        },
      ]);
      expect(reportedFailures).toEqual(new Set([orphan]));
      chmodSync(reposDir(), 0o700);
      await sweep();
      expect(existsSync(cacheOf(orphan))).toBe(false);
      expect(events()).toEqual([
        { event: 'cache-delete-failed', repositoryId: orphan, code: 'EACCES' },
        { event: 'cache-deleted', repositoryId: orphan },
      ]);
      expect(reportedFailures.size).toBe(0);
    },
  );

  it('logs an injected EACCES of rm and keeps the cache', async () => {
    const orphan = createId('repo');
    plantCache(orphan);
    vi.mocked(fsPromises.rm).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );
    await sweep();
    expect(existsSync(cacheOf(orphan))).toBe(true);
    expect(events()).toEqual([
      { event: 'cache-delete-failed', repositoryId: orphan, code: 'EACCES' },
    ]);
  });

  it('counts ENOENT from rm as deleted: another process won the race', async () => {
    const orphan = createId('repo');
    plantCache(orphan);
    vi.mocked(fsPromises.rm).mockRejectedValueOnce(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
    );
    await sweep();
    expect(events()).toEqual([{ event: 'cache-deleted', repositoryId: orphan }]);
  });

  posixOnly('refuses an orphan replaced by a link after the listing (fail closed)', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    const orphan = createId('repo');
    plantCache(orphan);
    const { lstat } = await vi.importActual<typeof fsPromises>('node:fs/promises');
    // The swap happens between the listing's lstat and the deletion.
    vi.mocked(fsPromises.lstat).mockImplementationOnce(async (path) => {
      const stats = await lstat(path);
      rmSync(cacheOf(orphan), { recursive: true });
      symlinkSync(outside, cacheOf(orphan));
      return stats;
    });
    await sweep();
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(readlinkSync(cacheOf(orphan))).toBe(outside);
    expect(events()).toEqual([
      { event: 'cache-delete-failed', repositoryId: orphan, code: 'OUTSIDE_CACHE' },
    ]);
  });

  it('skips an entry that disappears while it is listed, and fails on another lstat error', async () => {
    const vanished = createId('repo');
    plantCache(vanished);
    vi.mocked(fsPromises.lstat).mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    expect(await listRepositoryCaches(cacheDir())).toEqual({
      root: reposDir(),
      caches: [],
      unknown: [],
    });
    vi.mocked(fsPromises.lstat).mockRejectedValueOnce(
      Object.assign(new Error('EIO'), { code: 'EIO' }),
    );
    await sweep();
    expect(events()).toEqual([{ event: 'cache-sweep-failed', code: 'EIO' }]);
    expect(existsSync(cacheOf(vanished))).toBe(true);
  });
});
