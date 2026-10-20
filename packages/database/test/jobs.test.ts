import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireNextJob,
  countJobsByStatus,
  enqueueBenchmarkJob,
  enqueueRepositoryRegistrationJob,
  enqueueRepositoryScanJob,
  finishJob,
  getBenchmarkRunDetail,
  getJob,
  getRepositoryRegistration,
  getRepositoryScan,
  heartbeatJob,
  interruptJobs,
  isCancellationRequested,
  listJobs,
  NotFoundError,
  recoverStaleJobs,
  requestJobCancellation,
  schema,
  UnsupportedRepositoryError,
} from '../src/index';
import { registerLocal, seedRun, seedTargets, type SeededTargets } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

afterEach(() => {
  vi.useRealTimers();
});

function payloadOf(targets: SeededTargets) {
  return { suiteVersionId: targets.suiteVersionId, artifactVersionId: targets.artifactVersionId };
}

describe('enqueueBenchmarkJob', () => {
  it('stores a pending benchmark-run job with the validated payload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    const job = await enqueueBenchmarkJob(handle.db, payload);
    expect(job).toMatchObject({
      type: 'benchmark-run',
      status: 'pending',
      payload,
      attempts: 0,
      runnerId: null,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    expect(job.id).toMatch(/^job_/);
    expect(await getJob(handle.db, job.id)).toEqual(job);
  });

  it('rejects payloads with unknown fields or empty ids', async () => {
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    await expect(
      enqueueBenchmarkJob(handle.db, { ...payload, status: 'completed' } as typeof payload),
    ).rejects.toThrow(/Unrecognized key/);
    await expect(
      enqueueBenchmarkJob(handle.db, { ...payload, suiteVersionId: '' }),
    ).rejects.toThrow();
    expect(await listJobs(handle.db)).toEqual([]);
  });

  it('rejects jobs referencing unknown versions', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    await expect(
      enqueueBenchmarkJob(handle.db, { suiteVersionId: 'x', artifactVersionId: 'y' }),
    ).rejects.toThrow(new NotFoundError('Suite version x not found'));
    const missingArtifact = enqueueBenchmarkJob(handle.db, {
      suiteVersionId: targets.suiteVersionId,
      artifactVersionId: 'y',
    });
    await expect(missingArtifact).rejects.toBeInstanceOf(NotFoundError);
    await expect(missingArtifact).rejects.toThrow('Artifact version y not found');
  });

  it('fails loudly when the database silently drops the insert', async () => {
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    // SQLite-specific: a trigger that ignores the insert makes RETURNING yield no row.
    handle.sqlite.exec(
      'CREATE TRIGGER drop_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(enqueueBenchmarkJob(handle.db, payload)).rejects.toThrow('Failed to enqueue job');
  });
});

describe('enqueueRepositoryRegistrationJob', () => {
  it('stores a pending registration job with the trimmed path', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const job = await enqueueRepositoryRegistrationJob(handle.db, { path: '  ~/code/skills/ ' });
    expect(job).toMatchObject({
      type: 'repository-registration',
      status: 'pending',
      payload: { path: '~/code/skills/' },
      result: null,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    expect(job.id).toMatch(/^job_/);
  });

  it('enqueues a normalised hosted URL and nothing else that looks like one', async () => {
    const handle = getHandle();
    const job = await enqueueRepositoryRegistrationJob(handle.db, {
      url: 'https://github.com/acme/skills',
    });
    expect(job.payload).toEqual({ url: 'https://github.com/acme/skills' });
    for (const payload of [
      { url: 'https://user:ghp_abcdefghijklmnopqrstuvwxyz@github.com/acme/skills' },
      { url: 'https://github.com/Acme/skills.git' },
      { url: 'https://gitlab.com/acme/skills' },
      { url: 'https://github.com/acme/skills', path: '/srv' },
    ]) {
      await expect(
        enqueueRepositoryRegistrationJob(handle.db, payload as { url: string }),
      ).rejects.toThrow();
    }
    expect(await handle.db.$count(schema.jobs)).toBe(1);
    expect(JSON.stringify(await handle.db.select().from(schema.jobs))).not.toContain('ghp_');
  });

  it('rejects relative paths and unknown fields without storing anything', async () => {
    const handle = getHandle();
    await expect(enqueueRepositoryRegistrationJob(handle.db, { path: 'code' })).rejects.toThrow(
      /absolute path/,
    );
    await expect(
      enqueueRepositoryRegistrationJob(handle.db, { path: '/srv', provider: 'github' } as {
        path: string;
      }),
    ).rejects.toThrow(/Unrecognized key/);
    expect(await handle.db.$count(schema.jobs)).toBe(0);
  });

  it('fails loudly when the database silently drops the insert', async () => {
    const handle = getHandle();
    handle.sqlite.exec(
      'CREATE TRIGGER drop_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(enqueueRepositoryRegistrationJob(handle.db, { path: '/srv' })).rejects.toThrow(
      'Failed to enqueue job',
    );
  });
});

describe('enqueueRepositoryRegistrationJob with a confirmed location', () => {
  it('stores the confirmed canonical location verbatim and rejects an invalid one', async () => {
    const handle = getHandle();
    const job = await enqueueRepositoryRegistrationJob(handle.db, {
      path: '~',
      confirmedLocation: '/home/tester',
    });
    expect(job.payload).toEqual({ path: '~', confirmedLocation: '/home/tester' });
    await expect(
      enqueueRepositoryRegistrationJob(handle.db, { path: '/srv', confirmedLocation: 'srv' }),
    ).rejects.toThrow(/not an absolute path/);
    expect(await handle.db.$count(schema.jobs)).toBe(1);
  });
});

describe('getRepositoryRegistration', () => {
  it('describes a filesystem-root rejection and a confirmation request', async () => {
    const handle = getHandle();
    const root = await enqueueRepositoryRegistrationJob(handle.db, { path: '/' });
    const rejection = { ok: false, code: 'filesystem-root', message: 'Not the root.' };
    await finishJob(handle.db, root.id, 'completed', undefined, rejection);
    expect(await getRepositoryRegistration(handle.db, root.id)).toMatchObject({
      result: rejection,
      repository: null,
    });

    const broad = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv' });
    const confirmation = {
      ok: false,
      code: 'confirmation-required',
      location: '/srv',
      home: null,
      overlaps: [{ repositoryId: 'repo_a', name: 'a', location: '/srv/a', relation: 'contains' }],
    };
    await finishJob(handle.db, broad.id, 'completed', undefined, confirmation);
    expect(await getRepositoryRegistration(handle.db, broad.id)).toMatchObject({
      result: confirmation,
      repository: null,
    });
  });

  it('returns null for unknown ids, other job types and rows that fail validation', async () => {
    const handle = getHandle();
    const benchmark = await enqueueBenchmarkJob(handle.db, payloadOf(await seedTargets(handle)));
    const base = {
      type: 'repository-registration' as const,
      status: 'completed' as const,
      createdAt: '2026-04-01T00:00:00Z',
    };
    await handle.db.insert(schema.jobs).values([
      { ...base, id: 'job_bad_payload', payload: { path: 'relative' } },
      { ...base, id: 'job_bad_result', payload: { path: '/srv' }, result: { ok: 'yes' } },
    ]);
    expect(await getRepositoryRegistration(handle.db, 'job_missing')).toBeNull();
    expect(await getRepositoryRegistration(handle.db, benchmark.id)).toBeNull();
    expect(await getRepositoryRegistration(handle.db, 'job_bad_payload')).toBeNull();
    expect(await getRepositoryRegistration(handle.db, 'job_bad_result')).toBeNull();
  });

  it('describes a pending job, a rejection and a registered repository', async () => {
    const handle = getHandle();
    const pending = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/pending' });
    expect(await getRepositoryRegistration(handle.db, pending.id)).toEqual({
      jobId: pending.id,
      status: 'pending',
      input: '/srv/pending',
      source: 'path',
      error: null,
      result: null,
      repository: null,
    });

    const rejected = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/missing' });
    const rejection = { ok: false, code: 'path-not-found', message: 'No directory exists.' };
    await finishJob(handle.db, rejected.id, 'completed', undefined, rejection);
    expect(await getRepositoryRegistration(handle.db, rejected.id)).toMatchObject({
      status: 'completed',
      result: rejection,
      repository: null,
    });

    const { repository } = await registerLocal(handle, {
      provider: 'local-git',
      name: 'skills',
      location: '/srv/skills',
      defaultBranch: 'main',
    });
    const done = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/skills/' });
    const success = { ok: true, repositoryId: repository.id, created: true };
    await finishJob(handle.db, done.id, 'completed', undefined, success);
    expect(await getRepositoryRegistration(handle.db, done.id)).toMatchObject({
      input: '/srv/skills/',
      source: 'path',
      result: success,
      repository,
    });

    const gone = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/gone' });
    await finishJob(handle.db, gone.id, 'completed', undefined, {
      ok: true,
      repositoryId: 'repo_gone',
      created: false,
    });
    expect(await getRepositoryRegistration(handle.db, gone.id)).toMatchObject({
      repository: null,
    });
  });

  it('describes the registration of a hosted URL', async () => {
    const handle = getHandle();
    const job = await enqueueRepositoryRegistrationJob(handle.db, {
      url: 'https://github.com/acme/skills',
    });
    expect(await getRepositoryRegistration(handle.db, job.id)).toMatchObject({
      input: 'https://github.com/acme/skills',
      source: 'url',
      result: null,
    });
    const rejection = { ok: false, code: 'auth-required', message: 'Not found or not public.' };
    await finishJob(handle.db, job.id, 'completed', undefined, rejection);
    expect(await getRepositoryRegistration(handle.db, job.id)).toMatchObject({
      result: rejection,
    });
  });

  it('passes the runner error of a failed job through', async () => {
    const handle = getHandle();
    const job = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv' });
    await finishJob(handle.db, job.id, 'failed', 'database is locked');
    expect(await getRepositoryRegistration(handle.db, job.id)).toMatchObject({
      status: 'failed',
      error: 'database is locked',
      result: null,
    });
  });
});

describe('acquireNextJob', () => {
  it('acquires each pending job exactly once in FIFO order', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const a = await enqueueBenchmarkJob(handle.db, payload);
    vi.setSystemTime(new Date('2026-04-01T00:00:01.000Z'));
    const b = await enqueueBenchmarkJob(handle.db, payload);

    vi.setSystemTime(new Date('2026-04-01T00:01:00.000Z'));
    const [first, second, none] = await Promise.all([
      acquireNextJob(handle.db, 'r1'),
      acquireNextJob(handle.db, 'r2'),
      acquireNextJob(handle.db, 'r3'),
    ]);
    expect(first).toMatchObject({
      id: a.id,
      status: 'running',
      runnerId: 'r1',
      attempts: 1,
      startedAt: '2026-04-01T00:01:00.000Z',
      heartbeatAt: '2026-04-01T00:01:00.000Z',
    });
    expect(second).toMatchObject({ id: b.id, runnerId: 'r2' });
    expect(none).toBeNull();
  });
});

describe('acquireNextJob by type', () => {
  it('claims only the requested job types, oldest first within them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const benchmark = await enqueueBenchmarkJob(handle.db, payload);
    vi.setSystemTime(new Date('2026-04-01T00:00:01.000Z'));
    const first = await enqueueRepositoryRegistrationJob(handle.db, { path: '/a' });
    vi.setSystemTime(new Date('2026-04-01T00:00:02.000Z'));
    const second = await enqueueRepositoryRegistrationJob(handle.db, { path: '/b' });

    const short = { types: ['repository-registration'] as const };
    expect((await acquireNextJob(handle.db, 'r', short))?.id).toBe(first.id);
    expect((await acquireNextJob(handle.db, 'r', short))?.id).toBe(second.id);
    expect(await acquireNextJob(handle.db, 'r', short)).toBeNull();
    const long = { types: ['benchmark-run', 'repository-scan'] as const };
    expect((await acquireNextJob(handle.db, 'r', long))?.id).toBe(benchmark.id);
  });
});

describe('enqueueRepositoryScanJob', () => {
  it('queues one scan per local repository and returns the pending or running one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const { repository } = await registerLocal(handle, { location: '/srv/skills' });
    const { repository: other } = await registerLocal(handle, {
      provider: 'local-git',
      location: '/srv/rules',
    });

    const first = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
    expect(first).toMatchObject({
      created: true,
      job: {
        type: 'repository-scan',
        status: 'pending',
        payload: { repositoryId: repository.id },
        createdAt: '2026-04-01T00:00:00.000Z',
      },
    });
    const otherScan = await enqueueRepositoryScanJob(handle, { repositoryId: other.id });
    expect(otherScan.created).toBe(true);
    const [again, concurrent] = await Promise.all([
      enqueueRepositoryScanJob(handle, { repositoryId: repository.id }),
      enqueueRepositoryScanJob(handle, { repositoryId: repository.id }),
    ]);
    expect(again).toEqual({ job: first.job, created: false });
    expect(concurrent).toEqual({ job: first.job, created: false });

    await acquireNextJob(handle.db, 'r');
    expect((await enqueueRepositoryScanJob(handle, { repositoryId: repository.id })).created).toBe(
      false,
    );
    await finishJob(handle.db, first.job.id, 'completed');
    const next = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
    expect(next.created).toBe(true);
    expect(next.job.id).not.toBe(first.job.id);
  });

  it('ignores scan rows whose payload no longer validates', async () => {
    const handle = getHandle();
    const { repository } = await registerLocal(handle, { location: '/srv/skills' });
    await handle.db.insert(schema.jobs).values({
      id: 'job_bad',
      type: 'repository-scan',
      status: 'pending',
      payload: { repositoryId: '' },
      createdAt: '2026-04-01T00:00:00Z',
    });
    expect((await enqueueRepositoryScanJob(handle, { repositoryId: repository.id })).created).toBe(
      true,
    );
  });

  it('rejects unknown and non-local repositories and invalid payloads', async () => {
    const handle = getHandle();
    const { artifactId } = await seedTargets(handle, {
      artifact: {
        repository: { provider: 'bundled-examples', name: 'Bundled', location: '/opt/examples' },
      },
    });
    expect(artifactId).toMatch(/^art_/);
    const bundled = await handle.db.select().from(schema.repositories).get();
    await expect(
      enqueueRepositoryScanJob(handle, { repositoryId: 'repo_missing' }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      enqueueRepositoryScanJob(handle, { repositoryId: bundled?.id ?? '' }),
    ).rejects.toThrow(UnsupportedRepositoryError);
    await expect(
      enqueueRepositoryScanJob(handle, { repositoryId: 'r', path: '/etc' } as {
        repositoryId: string;
      }),
    ).rejects.toThrow(/Unrecognized key/);
    expect(await handle.db.$count(schema.jobs)).toBe(0);
  });

  it('fails loudly when the database silently drops the insert', async () => {
    const handle = getHandle();
    const { repository } = await registerLocal(handle, { location: '/srv/skills' });
    handle.sqlite.exec(
      'CREATE TRIGGER drop_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(enqueueRepositoryScanJob(handle, { repositoryId: repository.id })).rejects.toThrow(
      'Failed to enqueue job',
    );
  });
});

describe('getRepositoryScan', () => {
  const success = {
    ok: true,
    scannedFiles: 3,
    discovered: 1,
    createdArtifacts: 1,
    createdVersions: 1,
    warningCount: 0,
    errorCount: 1,
    errors: [{ path: 'AGENTS.md', code: 'symlink', message: 'AGENTS.md is a symbolic link' }],
    durationMs: 12,
  };

  it('returns null for unknown ids, other job types and rows that fail validation', async () => {
    const handle = getHandle();
    const registration = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv' });
    const base = {
      type: 'repository-scan' as const,
      status: 'completed' as const,
      createdAt: '2026-04-01T00:00:00Z',
    };
    await handle.db.insert(schema.jobs).values([
      { ...base, id: 'job_bad_payload', payload: { repositoryId: '' } },
      { ...base, id: 'job_bad_result', payload: { repositoryId: 'r' }, result: { ok: 'yes' } },
    ]);
    expect(await getRepositoryScan(handle.db, 'job_missing')).toBeNull();
    expect(await getRepositoryScan(handle.db, registration.id)).toBeNull();
    expect(await getRepositoryScan(handle.db, 'job_bad_payload')).toBeNull();
    expect(await getRepositoryScan(handle.db, 'job_bad_result')).toBeNull();
  });

  it('describes a pending scan, its result and a repository that is gone', async () => {
    const handle = getHandle();
    const { repository } = await registerLocal(handle, { location: '/srv/skills' });
    const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
    expect(await getRepositoryScan(handle.db, job.id)).toEqual({
      jobId: job.id,
      status: 'pending',
      repositoryId: repository.id,
      error: null,
      result: null,
      repository,
    });
    await finishJob(handle.db, job.id, 'completed', undefined, success);
    // A result stored before skipped user-level folders were reported reads as "none skipped".
    expect(await getRepositoryScan(handle.db, job.id)).toMatchObject({
      status: 'completed',
      result: { ...success, skippedUserLevelFolders: [] },
    });
    handle.sqlite
      .prepare('update jobs set result = ? where id = ?')
      .run(JSON.stringify({ ...success, skippedUserLevelFolders: ['.claude'] }), job.id);
    expect((await getRepositoryScan(handle.db, job.id))?.result).toEqual({
      ...success,
      skippedUserLevelFolders: ['.claude'],
      commitSha: null,
    });
    // A hosted scan names the commit it read; anything but a full hex object ID is rejected.
    const commitSha = 'a'.repeat(40);
    handle.sqlite
      .prepare('update jobs set result = ? where id = ?')
      .run(JSON.stringify({ ...success, commitSha }), job.id);
    expect((await getRepositoryScan(handle.db, job.id))?.result).toMatchObject({ commitSha });
    handle.sqlite
      .prepare('update jobs set result = ? where id = ?')
      .run(JSON.stringify({ ...success, commitSha: 'HEAD' }), job.id);
    expect(await getRepositoryScan(handle.db, job.id)).toBeNull();
    handle.sqlite
      .prepare('update jobs set result = ? where id = ?')
      .run(JSON.stringify(success), job.id);
    handle.sqlite.exec('delete from repositories');
    expect(await getRepositoryScan(handle.db, job.id)).toMatchObject({ repository: null });
  });
});

describe('heartbeatJob', () => {
  it('updates the heartbeat of running jobs only', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    const pending = await enqueueBenchmarkJob(handle.db, payload);

    vi.setSystemTime(new Date('2026-04-01T00:00:30.000Z'));
    await heartbeatJob(handle.db, pending.id);
    expect((await getJob(handle.db, pending.id))?.heartbeatAt).toBeNull();

    await acquireNextJob(handle.db, 'r');
    vi.setSystemTime(new Date('2026-04-01T00:01:00.000Z'));
    await heartbeatJob(handle.db, pending.id);
    expect((await getJob(handle.db, pending.id))?.heartbeatAt).toBe('2026-04-01T00:01:00.000Z');
  });
});

describe('finishJob', () => {
  it('never overwrites a job that already reached a terminal state (FR-114-14)', async () => {
    const handle = getHandle();
    const job = await enqueueBenchmarkJob(handle.db, payloadOf(await seedTargets(handle)));
    await acquireNextJob(handle.db, 'r');
    await interruptJobs(handle.db, [job.id], 'Runner shut down before the job stopped');
    await finishJob(handle.db, job.id, 'completed', undefined, { late: true });
    expect(await getJob(handle.db, job.id)).toMatchObject({
      status: 'interrupted',
      result: null,
      error: 'Runner shut down before the job stopped',
    });
  });

  it('records the final status, error and finish time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    const ok = await enqueueBenchmarkJob(handle.db, payload);
    const bad = await enqueueBenchmarkJob(handle.db, payload);
    await finishJob(handle.db, ok.id, 'completed');
    await finishJob(handle.db, bad.id, 'failed', 'adapter crashed');
    expect(await getJob(handle.db, ok.id)).toMatchObject({
      status: 'completed',
      error: null,
      finishedAt: '2026-04-01T00:00:00.000Z',
    });
    expect(await getJob(handle.db, bad.id)).toMatchObject({
      status: 'failed',
      error: 'adapter crashed',
    });
  });
});

describe('requestJobCancellation', () => {
  it('cancels pending jobs immediately and flags running ones', async () => {
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    const pending = await enqueueBenchmarkJob(handle.db, payload);
    expect(await requestJobCancellation(handle.db, pending.id)).toBe('cancelled');
    expect(await isCancellationRequested(handle.db, pending.id)).toBe(true);
    expect(await acquireNextJob(handle.db, 'r')).toBeNull();

    const running = await enqueueBenchmarkJob(handle.db, payload);
    await acquireNextJob(handle.db, 'r');
    expect(await isCancellationRequested(handle.db, running.id)).toBe(false);
    expect(await requestJobCancellation(handle.db, running.id)).toBe('running');
    expect(await isCancellationRequested(handle.db, running.id)).toBe(true);
    await finishJob(handle.db, running.id, 'cancelled');
    expect(await requestJobCancellation(handle.db, running.id)).toBe('cancelled');
  });

  it('keeps the first cancellation request time and leaves finished jobs alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    const running = await enqueueBenchmarkJob(handle.db, payload);
    await acquireNextJob(handle.db, 'r');
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    await requestJobCancellation(handle.db, running.id);
    vi.setSystemTime(new Date('2026-04-01T00:10:00.000Z'));
    await requestJobCancellation(handle.db, running.id);
    expect((await getJob(handle.db, running.id))?.cancelRequestedAt).toBe(
      '2026-04-01T00:00:00.000Z',
    );

    const done = await enqueueBenchmarkJob(handle.db, payload);
    await finishJob(handle.db, done.id, 'completed');
    expect(await requestJobCancellation(handle.db, done.id)).toBe('completed');
    expect(await isCancellationRequested(handle.db, done.id)).toBe(false);
  });

  it('returns null for unknown jobs', async () => {
    const { db } = getHandle();
    expect(await requestJobCancellation(db, 'job_missing')).toBeNull();
    expect(await isCancellationRequested(db, 'job_missing')).toBe(false);
    expect(await getJob(db, 'job_missing')).toBeNull();
  });
});

describe('recoverStaleJobs and interruptJobs', () => {
  it('marks jobs with stale or missing heartbeats as interrupted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const payload = payloadOf(await seedTargets(handle));
    const job = await enqueueBenchmarkJob(handle.db, payload);
    vi.setSystemTime(new Date('2026-04-01T00:00:01.000Z'));
    const silent = await enqueueBenchmarkJob(handle.db, payload);
    vi.setSystemTime(new Date('2026-04-01T00:00:02.000Z'));
    const pending = await enqueueBenchmarkJob(handle.db, payload);
    vi.setSystemTime(new Date('2026-04-01T00:00:03.000Z'));
    await acquireNextJob(handle.db, 'r');
    await acquireNextJob(handle.db, 'r');
    await handle.db
      .update(schema.jobs)
      .set({ heartbeatAt: null })
      .where(eq(schema.jobs.id, silent.id));

    expect(await recoverStaleJobs(handle.db, '2026-03-01T00:00:00.000Z')).toEqual([silent.id]);
    expect(await recoverStaleJobs(handle.db, '2026-05-01T00:00:00.000Z')).toEqual([job.id]);
    expect(await getJob(handle.db, job.id)).toMatchObject({
      status: 'interrupted',
      error: 'Runner stopped unexpectedly while the job was running',
      finishedAt: '2026-04-01T00:00:03.000Z',
    });
    expect((await getJob(handle.db, pending.id))?.status).toBe('pending');
    expect(await recoverStaleJobs(handle.db, '2026-05-01T00:00:00.000Z')).toEqual([]);
  });

  it('interrupts running jobs together with their running benchmark runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const job = await enqueueBenchmarkJob(handle.db, payloadOf(targets));
    vi.setSystemTime(new Date('2026-04-01T00:00:01.000Z'));
    const pending = await enqueueBenchmarkJob(handle.db, payloadOf(targets));
    await acquireNextJob(handle.db, 'r');
    const runId = await seedRun(handle, targets, { jobId: job.id });

    expect(await interruptJobs(handle.db, [], 'shutdown')).toEqual([]);
    expect(await interruptJobs(handle.db, [pending.id], 'shutdown')).toEqual([]);
    expect(await interruptJobs(handle.db, [job.id, pending.id], 'shutdown')).toEqual([job.id]);

    expect((await getJob(handle.db, job.id))?.status).toBe('interrupted');
    expect((await getJob(handle.db, pending.id))?.status).toBe('pending');
    expect((await getBenchmarkRunDetail(handle.db, runId))?.run).toMatchObject({
      status: 'interrupted',
      error: 'shutdown',
    });
  });
});

describe('listJobs', () => {
  it('lists newest jobs first with suite, artifact and run labels', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = getHandle();
    const targets = await seedTargets(handle, { artifact: { name: 'Validator' } });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const older = await enqueueBenchmarkJob(handle.db, payloadOf(targets));
    vi.setSystemTime(new Date('2026-04-02T00:00:00.000Z'));
    const newer = await enqueueBenchmarkJob(handle.db, payloadOf(targets));
    const runId = await seedRun(handle, targets, { jobId: older.id });

    const jobs = await listJobs(handle.db);
    expect(jobs.map((j) => j.job.id)).toEqual([newer.id, older.id]);
    expect(jobs[0]).toMatchObject({
      suiteName: 'Suite',
      artifactName: 'Validator',
      benchmarkRunId: null,
    });
    expect(jobs[1]?.benchmarkRunId).toBe(runId);
    expect((await listJobs(handle.db, 1)).map((j) => j.job.id)).toEqual([newer.id]);
  });

  it('lists benchmark jobs only; registration jobs belong to the Repositories page', async () => {
    const handle = getHandle();
    const benchmark = await enqueueBenchmarkJob(handle.db, payloadOf(await seedTargets(handle)));
    await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv/skills' });
    expect((await listJobs(handle.db)).map((j) => j.job.id)).toEqual([benchmark.id]);
  });

  it('leaves labels empty when the payload or its targets cannot be resolved', async () => {
    const { db } = getHandle();
    const base = { type: 'benchmark-run' as const, status: 'failed' as const };
    await db.insert(schema.jobs).values([
      { ...base, id: 'job_a', payload: { unexpected: true }, createdAt: '2026-04-01T00:00:00Z' },
      {
        ...base,
        id: 'job_b',
        payload: { suiteVersionId: 'suitev_gone', artifactVersionId: 'artv_gone' },
        createdAt: '2026-04-02T00:00:00Z',
      },
    ]);
    expect(await listJobs(db)).toEqual([
      expect.objectContaining({ suiteName: null, artifactName: null, benchmarkRunId: null }),
      expect.objectContaining({ suiteName: null, artifactName: null, benchmarkRunId: null }),
    ]);
  });
});

describe('countJobsByStatus', () => {
  it('counts every status, including ones without jobs', async () => {
    const handle = getHandle();
    expect(await countJobsByStatus(handle.db)).toEqual({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    });
    const payload = payloadOf(await seedTargets(handle));
    const a = await enqueueBenchmarkJob(handle.db, payload);
    await enqueueBenchmarkJob(handle.db, payload);
    await enqueueBenchmarkJob(handle.db, payload);
    await finishJob(handle.db, a.id, 'failed', 'x');
    await acquireNextJob(handle.db, 'r');
    expect(await countJobsByStatus(handle.db)).toEqual({
      pending: 1,
      running: 1,
      completed: 0,
      failed: 1,
      cancelled: 0,
      interrupted: 0,
    });
  });
});
