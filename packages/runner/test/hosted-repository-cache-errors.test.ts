import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueRepositoryRegistrationJob,
  enqueueRepositoryScanJob,
  getRepository,
  getRepositoryRegistration,
  getRepositoryScan,
  migrateDatabase,
  openDatabase,
  registerHostedRepository,
  schema,
  type DatabaseHandle,
  type RepositoryRecord,
} from '@directivebench/database';
import type * as hostedGit from '../src/hosted-git';
import {
  GitCancelledError,
  LocalRunner,
  registerHostedUrl,
  scanHostedRepository,
  type HostedRepositoryOptions,
} from '../src/index';
import { FixtureRemote, fakeGit, fileTransport } from './support/hosted-fixtures';

// Issue #57: errors of DirectiveBench's own cache below `<dataDir>/cache`. The file-system
// functions stay real; a test makes one of them fail where real permissions cannot.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    chmod: vi.fn(actual.chmod),
    lstat: vi.fn(actual.lstat),
    mkdir: vi.fn(actual.mkdir),
    readdir: vi.fn(actual.readdir),
    rm: vi.fn(actual.rm),
  };
});
const hooks = vi.hoisted(() => ({ listingFails: false }));
vi.mock('../src/hosted-git', async (importOriginal) => {
  const actual = await importOriginal<typeof hostedGit>();
  return {
    ...actual,
    listSnapshot: (...args: Parameters<typeof actual.listSnapshot>) =>
      hooks.listingFails
        ? Promise.resolve({ ok: false, code: 'git-failed', message: 'git ls-tree failed: x' })
        : actual.listSnapshot(...args),
  };
});

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));
const posixOnly = it.skipIf(process.platform === 'win32');

const cacheMessage = (code: string) =>
  `DirectiveBench could not use its cache of hosted repositories in the data directory (${code}). Check that the data directory is writable and the disk has free space.`;

let handle: DatabaseHandle;
let dataDir: string;
let remotes: string;
/** Directories a test made read-only, restored before the clean-up. */
let locked: string[];

beforeEach(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-cache-errors-')));
  remotes = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-cache-errors-remotes-')));
  locked = [];
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
});

afterEach(() => {
  hooks.listingFails = false;
  vi.clearAllMocks();
  for (const dir of locked) chmodSync(dir, 0o700);
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(remotes, { recursive: true, force: true });
});

const cacheDir = () => join(dataDir, 'cache');
const cacheOf = (repositoryId: string) => join(cacheDir(), 'repos', `${repositoryId}.git`);

function options(overrides: Partial<HostedRepositoryOptions> = {}): HostedRepositoryOptions {
  return {
    env: { PATH: process.env.PATH },
    signal: new AbortController().signal,
    cacheDir: cacheDir(),
    transport: fileTransport(remotes),
    cacheSizePollIntervalMs: 5,
    ...overrides,
  };
}

function errno(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation failed, '${path}'`), { code, path });
}

function skills(): FixtureRemote {
  return new FixtureRemote(remotes, 'acme', 'skills', {
    'AGENTS.md': '# Rules\n',
    'skill/SKILL.md': '---\nname: s\ndescription: d\n---\n',
  });
}

async function registered(remote: FixtureRemote): Promise<RepositoryRecord> {
  const result = await registerHostedUrl(handle, remote.location, options());
  if (!result.ok) throw new Error(result.message);
  return (await getRepository(handle.db, result.repositoryId)) as RepositoryRecord;
}

async function scan(
  repository: RepositoryRecord,
  overrides: Partial<HostedRepositoryOptions> = {},
) {
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
  handle.sqlite.prepare(`update jobs set status = 'running' where id = ?`).run(job.id);
  const current = (await getRepository(handle.db, repository.id)) as RepositoryRecord;
  return scanHostedRepository(handle, { jobId: job.id, repository: current }, options(overrides));
}

/** The scan failed with the fixed cache message, recorded as the repository's sync error. */
async function expectCacheFailure(
  result: Awaited<ReturnType<typeof scan>>,
  repository: RepositoryRecord,
  code: string,
): Promise<void> {
  expect(result).toEqual({ ok: false, code: 'git-failed', message: cacheMessage(code) });
  expect(await getRepository(handle.db, repository.id)).toMatchObject({
    syncStatus: 'error',
    syncError: cacheMessage(code),
  });
}

describe('hosted registration with a cache that cannot be used', () => {
  posixOnly('rejects the URL with the fixed message when the cache cannot be created', async () => {
    const remote = skills();
    const parent = join(dataDir, 'read-only');
    mkdirSync(parent, { mode: 0o500 });
    locked.push(parent);
    const result = await registerHostedUrl(
      handle,
      remote.location,
      options({ cacheDir: join(parent, 'cache') }),
    );
    expect(result).toEqual({ ok: false, code: 'git-failed', message: cacheMessage('EACCES') });
    expect(await handle.db.$count(schema.repositories)).toBe(0);
  });

  it('reports a failed chmod of the cache the same way', async () => {
    vi.mocked(fsPromises.chmod).mockRejectedValueOnce(errno('EPERM', cacheDir()));
    expect(await registerHostedUrl(handle, skills().location, options())).toEqual({
      ok: false,
      code: 'git-failed',
      message: cacheMessage('EPERM'),
    });
  });

  it('stays a cancellation when the job was cancelled before the cache failed', async () => {
    const controller = new AbortController();
    vi.mocked(fsPromises.mkdir).mockImplementationOnce(async (path) => {
      controller.abort('cancelled');
      throw errno('EACCES', String(path));
    });
    await expect(
      registerHostedUrl(handle, skills().location, options({ signal: controller.signal })),
    ).rejects.toThrow(GitCancelledError);
  });
});

describe('hosted scan with a cache that cannot be used', () => {
  it('fails and records the error when the cache directories cannot be created', async () => {
    const repository = await registered(skills());
    rmSync(join(cacheDir(), 'repos'), { recursive: true });
    // A regular file where the directory belongs: `mkdir` fails with EEXIST.
    writeFileSync(join(cacheDir(), 'repos'), '');
    await expectCacheFailure(await scan(repository), repository, 'EEXIST');
  });

  it('fails closed when the cache cannot be checked, without cloning', async () => {
    const repository = await registered(skills());
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    vi.mocked(fsPromises.lstat).mockImplementation((async (path: string) => {
      if (path === cacheOf(repository.id)) throw errno('EACCES', path);
      return actual.lstat(path);
    }) as never);
    await expectCacheFailure(await scan(repository), repository, 'EACCES');
  });

  it('fails when the new cache cannot be made private after the clone', async () => {
    const repository = await registered(skills());
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    vi.mocked(fsPromises.chmod).mockImplementation(async (path, mode) => {
      if (String(path) === cacheOf(repository.id)) throw errno('EPERM', String(path));
      return actual.chmod(path, mode);
    });
    await expectCacheFailure(await scan(repository), repository, 'EPERM');
  });

  it('fails when the cache cannot be measured after a download', async () => {
    const repository = await registered(skills());
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    vi.mocked(fsPromises.readdir).mockImplementation((async (path: string, opts: never) => {
      if (String(path) === cacheOf(repository.id)) throw errno('EIO', String(path));
      return actual.readdir(path, opts);
    }) as never);
    // The size watch never fires during this short clone (interval far beyond it).
    await expectCacheFailure(
      await scan(repository, { cacheSizePollIntervalMs: 10 * 60_000 }),
      repository,
      'EIO',
    );
  });

  posixOnly('fails when the size check fails while git downloads, and stops git', async () => {
    // A fake git whose clone keeps running: only the size watch can end it.
    const git = fakeGit(join(dataDir, 'bin'), {
      version: { stdout: 'git version 2.50.0\n' },
      clone: { creates: { HEAD: 1 }, sleepMs: 30_000 },
    });
    const { repository } = await registerHostedRepository(handle.db, {
      provider: 'github',
      name: 'acme/slow',
      location: 'https://github.com/acme/slow',
      defaultBranch: 'main',
    });
    vi.mocked(fsPromises.readdir).mockRejectedValueOnce(errno('EACCES', cacheOf(repository.id)));
    const started = Date.now();
    const result = await scan(repository, { env: { PATH: join(git, '..') } });
    await expectCacheFailure(result, repository, 'EACCES');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  posixOnly('fails when a failed fetch leaves a cache that cannot be deleted', async () => {
    const remote = skills();
    const repository = await registered(remote);
    expect(await scan(repository)).toMatchObject({ ok: true });
    remote.commit({ 'AGENTS.md': '# Changed\n' });
    // The cache cannot be written (git's fetch fails) nor emptied (its deletion fails).
    chmodSync(cacheOf(repository.id), 0o500);
    locked.push(cacheOf(repository.id));
    await expectCacheFailure(await scan(repository), repository, 'EACCES');
  });

  it('fails when the cache of a failed step cannot be deleted', async () => {
    const repository = await registered(skills());
    hooks.listingFails = true;
    vi.mocked(fsPromises.rm).mockRejectedValueOnce(errno('EBUSY', cacheOf(repository.id)));
    await expectCacheFailure(await scan(repository), repository, 'EBUSY');
  });

  it('stays a cancellation, recording nothing, when the job was cancelled before the cache failed', async () => {
    const repository = await registered(skills());
    const controller = new AbortController();
    vi.mocked(fsPromises.mkdir).mockImplementationOnce(async (path) => {
      controller.abort('shutdown');
      throw errno('ENOSPC', String(path));
    });
    await expect(scan(repository, { signal: controller.signal })).rejects.toThrow(
      GitCancelledError,
    );
    expect(await getRepository(handle.db, repository.id)).toMatchObject({
      syncStatus: 'never',
      syncError: null,
    });
  });

  it('ends the runner jobs with the fixed message and the error status', async () => {
    const remote = skills();
    const runner = new LocalRunner({
      handle,
      fixtureStore: join(dataDir, 'fixtures'),
      cacheDir: cacheDir(),
      adapters: new Map(),
      workspaceRoot: join(dataDir, 'workspaces'),
      hostedGitTransport: fileTransport(remotes),
    });
    // Registration: the cache path is a regular file.
    writeFileSync(cacheDir(), '');
    const registration = await enqueueRepositoryRegistrationJob(handle.db, {
      url: remote.location,
    });
    expect(await runner.runUntilIdle()).toMatchObject([{ status: 'completed' }]);
    expect((await getRepositoryRegistration(handle.db, registration.id))?.result).toEqual({
      ok: false,
      code: 'git-failed',
      message: cacheMessage('EEXIST'),
    });
    // Scan: registered while the cache worked, scanned once it no longer does.
    rmSync(cacheDir());
    const repository = await registered(remote);
    rmSync(cacheDir(), { recursive: true });
    writeFileSync(cacheDir(), '');
    const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
    const [finished] = await runner.runUntilIdle();
    expect(finished).toMatchObject({ status: 'failed', error: cacheMessage('EEXIST') });
    expect(finished?.error).not.toContain(dataDir);
    expect((await getRepositoryScan(handle.db, job.id))?.result).toMatchObject({
      ok: false,
      code: 'git-failed',
      message: cacheMessage('EEXIST'),
    });
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ syncStatus: 'error' });
  });
});
