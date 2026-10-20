import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueRepositoryRegistrationJob,
  getJob,
  getRepositoryRegistration,
  listRepositories,
  migrateDatabase,
  openDatabase,
  requestJobCancellation,
  type DatabaseHandle,
} from '@directivebench/database';
import { LocalRunner } from '../src/index';

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));

let handle: DatabaseHandle;
let dataDir: string;
let sources: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'directivebench-runner-registration-'));
  sources = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-sources-')));
  handle = openDatabase(join(dataDir, 'directivebench.db'));
  await migrateDatabase(handle, migrations);
});

afterEach(() => {
  vi.unstubAllEnvs();
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sources, { recursive: true, force: true });
});

function createRunner(overrides: Partial<ConstructorParameters<typeof LocalRunner>[0]> = {}) {
  return new LocalRunner({
    handle,
    fixtureStore: join(dataDir, 'fixtures'),
    cacheDir: join(dataDir, 'cache'),
    adapters: new Map(),
    workspaceRoot: join(dataDir, 'workspaces'),
    ...overrides,
  });
}

/** Puts a `git` that hangs first on PATH, so a registration stays running until aborted. */
function hangingGit(): void {
  const bin = join(sources, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);
}

describe('repository-registration jobs', () => {
  it('registers a git work tree and a plain directory, and returns duplicates', async () => {
    const repo = join(sources, 'skills');
    mkdirSync(join(repo, 'nested'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: repo });
    const plain = join(sources, 'rules');
    mkdirSync(plain);

    const jobs = [
      await enqueueRepositoryRegistrationJob(handle.db, { path: join(repo, 'nested') }),
      await enqueueRepositoryRegistrationJob(handle.db, { path: `${plain}/` }),
      await enqueueRepositoryRegistrationJob(handle.db, { path: repo }),
    ];
    const results = await createRunner().runUntilIdle();
    expect(results.map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);

    const registrations = await Promise.all(
      jobs.map((job) => getRepositoryRegistration(handle.db, job.id)),
    );
    expect(registrations.map((r) => r?.result?.ok && r.result.created)).toEqual([
      true,
      true,
      false,
    ]);
    expect(registrations[2]?.repository?.id).toBe(registrations[0]?.repository?.id);
    const listed = await listRepositories(handle.db);
    expect(listed.map((r) => [r.name, r.provider, r.location, r.defaultBranch])).toEqual([
      ['rules', 'local-directory', plain, null],
      ['skills', 'local-git', repo, 'trunk'],
    ]);
  });

  it('completes with a typed rejection and stores nothing for a missing path', async () => {
    const job = await enqueueRepositoryRegistrationJob(handle.db, {
      path: join(sources, 'missing'),
    });
    const [result] = await createRunner().runUntilIdle();
    expect(result).toMatchObject({ jobId: job.id, status: 'completed', error: null });
    expect((await getJob(handle.db, job.id))?.result).toEqual({
      ok: false,
      code: 'path-not-found',
      message: 'No directory exists at this path.',
    });
    expect(await listRepositories(handle.db)).toEqual([]);
  });

  it('fails a job whose payload no longer validates', async () => {
    const job = await enqueueRepositoryRegistrationJob(handle.db, { path: sources });
    handle.sqlite.exec(`update jobs set payload = '{"path":"relative/path"}'`);
    const [result] = await createRunner().runUntilIdle();
    expect(result).toMatchObject({ jobId: job.id, status: 'failed' });
    expect(result?.error).toMatch(/absolute path/);
    expect((await getJob(handle.db, job.id))?.result).toBeNull();
  });

  it('turns a cancellation request into `cancelled` while git runs', async () => {
    hangingGit();
    const job = await enqueueRepositoryRegistrationJob(handle.db, { path: sources });
    const runner = createRunner({ heartbeatIntervalMs: 10 });
    await runner.poll();
    expect(await requestJobCancellation(handle.db, job.id)).toBe('running');

    const [result] = await runner.runUntilIdle();
    expect(result).toMatchObject({ jobId: job.id, status: 'cancelled', error: null });
    expect(await listRepositories(handle.db)).toEqual([]);
  });

  it('records a registration interrupted by shutdown as `interrupted`', async () => {
    hangingGit();
    const job = await enqueueRepositoryRegistrationJob(handle.db, { path: sources });
    const runner = createRunner();
    await runner.poll();
    expect(runner.activeJobCount).toBe(1);

    await runner.stop();
    expect((await getJob(handle.db, job.id))?.status).toBe('interrupted');
  });
});
