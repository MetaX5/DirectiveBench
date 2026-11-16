import { describe, expect, it } from 'vitest';
import {
  BranchChangedError,
  JobNoLongerRunningError,
  NotFoundError,
  UnsupportedRepositoryError,
  acquireNextJob,
  applyRepositoryScan,
  enqueueRepositoryBranchJob,
  enqueueRepositoryRegistrationJob,
  enqueueRepositoryScanJob,
  finishJob,
  getRepository,
  getRepositoryBranchChange,
  getRepositoryRegistration,
  recordUnchangedRepositoryScan,
  registerHostedRepository,
  repositoryBranchPayloadSchema,
  repositoryBranchResultSchema,
  repositoryRegistrationPayloadSchema,
  repositoryScanResultSchema,
  requestJobCancellation,
  setRepositoryBranch,
  type DatabaseHandle,
  type ScannedArtifactInput,
} from '../src/index';
import { registerLocal } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

// Issue 58 (SPEC-104 FR-104-07, FR-104-14; SPEC-105 §14): the branch a hosted repository is
// scanned on, the job that changes it, and the scan's re-check of the branch it read.

const getHandle = useTestDatabase();
const signal = new AbortController().signal;
const COMMIT = 'a'.repeat(40);

async function hosted(
  handle: DatabaseHandle,
  repo = 'skills',
  branches: { defaultBranch?: string | null; selectedBranch?: string | null } = {},
) {
  const { repository } = await registerHostedRepository(handle.db, {
    provider: 'github',
    name: `acme/${repo}`,
    location: `https://github.com/acme/${repo}`,
    defaultBranch: branches.defaultBranch === undefined ? 'main' : branches.defaultBranch,
    selectedBranch: branches.selectedBranch ?? null,
  });
  return repository.id;
}

/** Enqueues and claims the next job of `type`, as the runner does. */
async function claimed(handle: DatabaseHandle, type: 'repository-scan' | 'repository-branch') {
  const job = await acquireNextJob(handle.db, 'runner', { types: [type] });
  if (!job) throw new Error(`no ${type} job`);
  return job.id;
}

async function branchJob(handle: DatabaseHandle, repositoryId: string, branch: string | null) {
  const outcome = await enqueueRepositoryBranchJob(handle, { repositoryId, branch });
  if (outcome.status !== 'enqueued') throw new Error(outcome.status);
  await claimed(handle, 'repository-branch');
  return outcome.job.id;
}

function scanned(path: string): ScannedArtifactInput {
  return {
    path,
    name: path,
    type: 'instruction',
    description: null,
    format: 'agents-md',
    primaryFile: 'AGENTS.md',
    files: [{ path: 'AGENTS.md', content: '# Rules\n' }],
    parsedMetadata: { warnings: [] },
  };
}

describe('job schemas (issue 58)', () => {
  it('accepts a safe branch with a URL registration and never an empty or unsafe one', () => {
    const url = 'https://github.com/acme/skills';
    expect(repositoryRegistrationPayloadSchema.parse({ url, branch: 'release/2.0' })).toEqual({
      url,
      branch: 'release/2.0',
    });
    expect(repositoryRegistrationPayloadSchema.parse({ url })).toEqual({ url });
    for (const branch of ['', '-upload-pack=x', 'a..b', null]) {
      expect(repositoryRegistrationPayloadSchema.safeParse({ url, branch }).success).toBe(false);
    }
    // A local path never carries a branch.
    expect(
      repositoryRegistrationPayloadSchema.safeParse({ path: '/srv', branch: 'main' }).success,
    ).toBe(false);
  });

  it('parses a branch change payload strictly, null meaning the default branch', () => {
    expect(repositoryBranchPayloadSchema.parse({ repositoryId: 'repo_1', branch: null })).toEqual({
      repositoryId: 'repo_1',
      branch: null,
    });
    expect(repositoryBranchPayloadSchema.safeParse({ repositoryId: 'repo_1' }).success).toBe(false);
    expect(
      repositoryBranchPayloadSchema.safeParse({ repositoryId: 'repo_1', branch: 'a b' }).success,
    ).toBe(false);
    expect(
      repositoryBranchPayloadSchema.safeParse({ repositoryId: 'repo_1', branch: 'x', extra: 1 })
        .success,
    ).toBe(false);
  });

  it('parses a branch change result', () => {
    expect(
      repositoryBranchResultSchema.parse({ ok: true, branch: 'dev', defaultBranch: null }),
    ).toEqual({ ok: true, branch: 'dev', defaultBranch: null });
    expect(
      repositoryBranchResultSchema.safeParse({ ok: false, code: 'scan-active', message: 'Wait.' })
        .success,
    ).toBe(true);
    expect(
      repositoryBranchResultSchema.safeParse({ ok: false, code: 'path-not-found', message: 'x' })
        .success,
    ).toBe(false);
  });

  it('records the branch a hosted scan read and the branch-changed failure', () => {
    const success = {
      ok: true,
      scannedFiles: 1,
      discovered: 1,
      createdArtifacts: 1,
      createdVersions: 1,
      warningCount: 0,
      errorCount: 0,
      errors: [],
      durationMs: 1,
    };
    expect(repositoryScanResultSchema.parse({ ...success, branch: 'dev' })).toMatchObject({
      branch: 'dev',
    });
    expect(repositoryScanResultSchema.parse(success)).not.toHaveProperty('branch');
    expect(repositoryScanResultSchema.safeParse({ ...success, branch: '-x' }).success).toBe(false);
    expect(
      repositoryScanResultSchema.safeParse({ ok: false, code: 'branch-changed', message: 'x' })
        .success,
    ).toBe(true);
  });
});

describe('registerHostedRepository with a branch (issue 58)', () => {
  it('stores the chosen branch for a new row and never changes it on a re-registration', async () => {
    const handle = getHandle();
    const id = await hosted(handle, 'skills', { selectedBranch: 'dev' });
    expect(await getRepository(handle.db, id)).toMatchObject({
      selectedBranch: 'dev',
      defaultBranch: 'main',
      scannedBranch: null,
    });
    const again = await registerHostedRepository(handle.db, {
      provider: 'github',
      name: 'acme/skills',
      location: 'https://github.com/acme/skills',
      defaultBranch: 'trunk',
      selectedBranch: null,
    });
    expect(again).toMatchObject({
      created: false,
      repository: { selectedBranch: 'dev', defaultBranch: 'trunk' },
    });
  });

  it('describes a URL registration with the branch the user named', async () => {
    const handle = getHandle();
    const named = await enqueueRepositoryRegistrationJob(handle.db, {
      url: 'https://github.com/acme/skills',
      branch: 'release/2.0',
    });
    const plain = await enqueueRepositoryRegistrationJob(handle.db, {
      url: 'https://github.com/acme/skills',
    });
    expect(await getRepositoryRegistration(handle.db, named.id)).toMatchObject({
      source: 'url',
      branch: 'release/2.0',
    });
    expect(await getRepositoryRegistration(handle.db, plain.id)).toMatchObject({ branch: null });
  });
});

describe('enqueueRepositoryBranchJob (issue 58)', () => {
  it('enqueues a branch change of a hosted repository once per identical request', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    const first = await enqueueRepositoryBranchJob(handle, { repositoryId: id, branch: 'dev' });
    expect(first).toMatchObject({ status: 'enqueued', created: true });
    expect(first.status === 'enqueued' && first.job).toMatchObject({
      type: 'repository-branch',
      status: 'pending',
      payload: { repositoryId: id, branch: 'dev' },
    });
    const same = await enqueueRepositoryBranchJob(handle, { repositoryId: id, branch: 'dev' });
    expect(same).toMatchObject({ status: 'enqueued', created: false });
    expect(same.status === 'enqueued' && first.status === 'enqueued' && same.job.id).toBe(
      first.status === 'enqueued' && first.job.id,
    );
    // While it runs too; a different request is refused instead of silently reusing it.
    await claimed(handle, 'repository-branch');
    expect(
      await enqueueRepositoryBranchJob(handle, { repositoryId: id, branch: 'dev' }),
    ).toMatchObject({ status: 'enqueued', created: false });
    expect(await enqueueRepositoryBranchJob(handle, { repositoryId: id, branch: null })).toEqual({
      status: 'branch-change-active',
    });
    // Another repository is independent.
    const other = await hosted(handle, 'other');
    expect(
      await enqueueRepositoryBranchJob(handle, { repositoryId: other, branch: null }),
    ).toMatchObject({ status: 'enqueued', created: true });
  });

  it('refuses while a scan of the repository is pending or running', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    const other = await hosted(handle, 'other');
    await enqueueRepositoryScanJob(handle, { repositoryId: id });
    expect(await enqueueRepositoryBranchJob(handle, { repositoryId: id, branch: 'dev' })).toEqual({
      status: 'scan-active',
    });
    await claimed(handle, 'repository-scan');
    expect(await enqueueRepositoryBranchJob(handle, { repositoryId: id, branch: 'dev' })).toEqual({
      status: 'scan-active',
    });
    expect(
      await enqueueRepositoryBranchJob(handle, { repositoryId: other, branch: 'dev' }),
    ).toMatchObject({ status: 'enqueued' });
  });

  it('fails loudly when the insert is dropped', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    // SQLite-specific: a trigger that ignores the insert makes RETURNING yield no row.
    handle.sqlite.exec(
      'CREATE TRIGGER drop_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(
      enqueueRepositoryBranchJob(handle, { repositoryId: id, branch: null }),
    ).rejects.toThrow('Failed to enqueue job');
  });

  it('rejects an unknown repository, a local one and an invalid payload', async () => {
    const handle = getHandle();
    await expect(
      enqueueRepositoryBranchJob(handle, { repositoryId: 'repo_missing', branch: null }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const { repository } = await registerLocal(handle, { location: '/srv/local', name: 'local' });
    await expect(
      enqueueRepositoryBranchJob(handle, { repositoryId: repository.id, branch: 'main' }),
    ).rejects.toBeInstanceOf(UnsupportedRepositoryError);
    await expect(
      enqueueRepositoryBranchJob(handle, { repositoryId: repository.id, branch: '-x' }),
    ).rejects.toThrow();
  });
});

describe('setRepositoryBranch (issue 58)', () => {
  it('stores the chosen branch, null for the default, and refreshes the default branch', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    let jobId = await branchJob(handle, id, 'dev');
    expect(
      await setRepositoryBranch(handle, {
        repositoryId: id,
        jobId,
        signal,
        branch: 'dev',
        defaultBranch: 'main',
      }),
    ).toEqual({ status: 'updated', branch: 'dev', defaultBranch: 'main' });
    expect(await getRepository(handle.db, id)).toMatchObject({ selectedBranch: 'dev' });
    await finishJob(handle.db, jobId, 'completed');

    // The detected default's own name is stored as null: the repository follows the default.
    jobId = await branchJob(handle, id, 'trunk');
    expect(
      await setRepositoryBranch(handle, {
        repositoryId: id,
        jobId,
        signal,
        branch: 'trunk',
        defaultBranch: 'trunk',
      }),
    ).toEqual({ status: 'updated', branch: null, defaultBranch: 'trunk' });
    expect(await getRepository(handle.db, id)).toMatchObject({
      selectedBranch: null,
      defaultBranch: 'trunk',
    });
    await finishJob(handle.db, jobId, 'completed');

    // A remote that reports no default branch keeps the known one.
    jobId = await branchJob(handle, id, 'trunk');
    expect(
      await setRepositoryBranch(handle, {
        repositoryId: id,
        jobId,
        signal,
        branch: 'trunk',
        defaultBranch: null,
      }),
    ).toEqual({ status: 'updated', branch: null, defaultBranch: 'trunk' });
  });

  it('refuses while a scan is pending or running and for a removed repository', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    const jobId = await branchJob(handle, id, 'dev');
    await enqueueRepositoryScanJob(handle, { repositoryId: id });
    const change = { repositoryId: id, jobId, signal, branch: 'dev', defaultBranch: 'main' };
    expect(await setRepositoryBranch(handle, change)).toEqual({ status: 'scan-active' });
    await claimed(handle, 'repository-scan');
    expect(await setRepositoryBranch(handle, change)).toEqual({ status: 'scan-active' });
    expect(await getRepository(handle.db, id)).toMatchObject({ selectedBranch: null });

    handle.sqlite.prepare('delete from repositories where id = ?').run(id);
    expect(await setRepositoryBranch(handle, change)).toEqual({ status: 'not-found' });
  });

  it('writes nothing for a cancelled, finished or aborted job', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    const jobId = await branchJob(handle, id, 'dev');
    const change = { repositoryId: id, jobId, signal, branch: 'dev', defaultBranch: 'main' };
    const aborted = new AbortController();
    aborted.abort('shutdown');
    await expect(
      setRepositoryBranch(handle, { ...change, signal: aborted.signal }),
    ).rejects.toBeInstanceOf(JobNoLongerRunningError);
    await requestJobCancellation(handle.db, jobId);
    await expect(setRepositoryBranch(handle, change)).rejects.toBeInstanceOf(
      JobNoLongerRunningError,
    );
    await expect(
      setRepositoryBranch(handle, { ...change, jobId: 'job_missing' }),
    ).rejects.toBeInstanceOf(JobNoLongerRunningError);
    expect(await getRepository(handle.db, id)).toMatchObject({ selectedBranch: null });
  });
});

describe('the scan write re-checks the branch it read (issue 58)', () => {
  async function runningScan(handle: DatabaseHandle, repositoryId: string) {
    await enqueueRepositoryScanJob(handle, { repositoryId });
    return claimed(handle, 'repository-scan');
  }

  it('records the scanned branch with the commit, and null for a working-tree scan', async () => {
    const handle = getHandle();
    const id = await hosted(handle, 'skills', { selectedBranch: 'dev' });
    const jobId = await runningScan(handle, id);
    await applyRepositoryScan(handle, {
      repositoryId: id,
      jobId,
      artifacts: [scanned('AGENTS.md')],
      unobserved: [],
      signal,
      commitSha: COMMIT,
      branch: 'dev',
    });
    expect(await getRepository(handle.db, id)).toMatchObject({
      lastCommitSha: COMMIT,
      scannedBranch: 'dev',
      syncStatus: 'ok',
    });

    const { repository } = await registerLocal(handle, { location: '/srv/local', name: 'local' });
    const localJob = await runningScan(handle, repository.id);
    await applyRepositoryScan(handle, {
      repositoryId: repository.id,
      jobId: localJob,
      artifacts: [],
      unobserved: [],
      signal,
      commitSha: null,
      branch: null,
    });
    expect(await getRepository(handle.db, repository.id)).toMatchObject({ scannedBranch: null });
  });

  it('applies nothing when the effective branch changed, in a full and in an unchanged scan', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    const jobId = await runningScan(handle, id);
    await applyRepositoryScan(handle, {
      repositoryId: id,
      jobId,
      artifacts: [scanned('AGENTS.md')],
      unobserved: [],
      signal,
      commitSha: COMMIT,
      branch: 'main',
    });
    await finishJob(handle.db, jobId, 'completed');
    const before = await getRepository(handle.db, id);

    // A re-registration refreshed the default branch while the next scan ran.
    const next = await runningScan(handle, id);
    handle.sqlite.prepare("update repositories set default_branch = 'trunk' where id = ?").run(id);
    await expect(
      applyRepositoryScan(handle, {
        repositoryId: id,
        jobId: next,
        artifacts: [],
        unobserved: [],
        signal,
        commitSha: 'b'.repeat(40),
        branch: 'main',
      }),
    ).rejects.toBeInstanceOf(BranchChangedError);
    await expect(
      recordUnchangedRepositoryScan(handle, {
        repositoryId: id,
        jobId: next,
        commitSha: COMMIT,
        branch: 'main',
        signal,
      }),
    ).rejects.toBeInstanceOf(BranchChangedError);
    expect(await getRepository(handle.db, id)).toEqual({ ...before, defaultBranch: 'trunk' });
    expect(
      handle.sqlite
        .prepare("select count(*) as n from artifact_occurrences where status = 'removed'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it('records the scanned branch of an unchanged rescan', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    handle.sqlite
      .prepare("update repositories set last_commit_sha = ?, sync_status = 'ok' where id = ?")
      .run(COMMIT, id);
    const jobId = await runningScan(handle, id);
    expect(
      await recordUnchangedRepositoryScan(handle, {
        repositoryId: id,
        jobId,
        commitSha: COMMIT,
        branch: 'main',
        signal,
      }),
    ).toBe(true);
    expect(await getRepository(handle.db, id)).toMatchObject({ scannedBranch: 'main' });
  });
});

describe('getRepositoryBranchChange (issue 58)', () => {
  it('describes a pending, a completed and a failed branch change', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    const outcome = await enqueueRepositoryBranchJob(handle, { repositoryId: id, branch: 'dev' });
    const jobId = outcome.status === 'enqueued' ? outcome.job.id : '';
    expect(await getRepositoryBranchChange(handle.db, jobId)).toMatchObject({
      jobId,
      status: 'pending',
      repositoryId: id,
      branch: 'dev',
      error: null,
      result: null,
      repository: { id, name: 'acme/skills' },
    });
    const result = { ok: true, branch: 'dev', defaultBranch: 'main' };
    await finishJob(handle.db, jobId, 'completed', undefined, result);
    expect(await getRepositoryBranchChange(handle.db, jobId)).toMatchObject({
      status: 'completed',
      result,
    });
    handle.sqlite.prepare('delete from repositories where id = ?').run(id);
    expect(await getRepositoryBranchChange(handle.db, jobId)).toMatchObject({ repository: null });
  });

  it('returns null for an unknown id, another job type, or a payload or result that does not parse', async () => {
    const handle = getHandle();
    const id = await hosted(handle);
    expect(await getRepositoryBranchChange(handle.db, 'job_missing')).toBeNull();
    const registration = await enqueueRepositoryRegistrationJob(handle.db, { path: '/srv' });
    expect(await getRepositoryBranchChange(handle.db, registration.id)).toBeNull();
    const insert = handle.sqlite.prepare(
      "insert into jobs (id, type, status, payload, result, created_at) values (?, 'repository-branch', 'completed', ?, ?, 't')",
    );
    insert.run('job_bad_payload', JSON.stringify({ repositoryId: id, branch: '-x' }), null);
    insert.run(
      'job_bad_result',
      JSON.stringify({ repositoryId: id, branch: null }),
      JSON.stringify({ ok: true }),
    );
    expect(await getRepositoryBranchChange(handle.db, 'job_bad_payload')).toBeNull();
    expect(await getRepositoryBranchChange(handle.db, 'job_bad_result')).toBeNull();
  });
});
