import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireNextJob,
  applyRepositoryScan,
  enqueueRepositoryScanJob,
  finishJob,
  getLastCompletedRepositoryScan,
  getRepository,
  JobNoLongerRunningError,
  NotFoundError,
  recordUnchangedRepositoryScan,
  registerHostedRepository,
  requestJobCancellation,
  schema,
  type DatabaseHandle,
  type ScannedArtifactInput,
} from '../src/index';
import { useTestDatabase } from './support/test-database';

// Issue 63 (SPEC-105 FR-105-10): the stored data a hosted rescan decides on, and the write of a
// rescan that found the remote unchanged.

const getHandle = useTestDatabase();
const signal = new AbortController().signal;
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const HASH = 'c'.repeat(64);

afterEach(() => {
  vi.useRealTimers();
});

function scanned(path: string, content: string): ScannedArtifactInput {
  return {
    path,
    name: path,
    type: 'instruction',
    description: null,
    format: 'agents-md',
    primaryFile: 'AGENTS.md',
    files: [{ path: 'AGENTS.md', content }],
    parsedMetadata: { warnings: [] },
  };
}

async function hosted(handle: DatabaseHandle, repo = 'skills') {
  const { repository } = await registerHostedRepository(handle.db, {
    provider: 'github',
    name: `acme/${repo}`,
    location: `https://github.com/acme/${repo}`,
    defaultBranch: 'main',
  });
  return repository.id;
}

/** Enqueues and claims a scan job of the repository, as the runner does. */
async function running(handle: DatabaseHandle, repositoryId: string): Promise<string> {
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId });
  await acquireNextJob(handle.db, 'runner');
  return job.id;
}

function success(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    scannedFiles: 3,
    discovered: 2,
    createdArtifacts: 2,
    createdVersions: 2,
    warningCount: 1,
    errorCount: 0,
    errors: [],
    commitSha: COMMIT,
    scanConfigHash: HASH,
    durationMs: 12,
    ...overrides,
  };
}

/** A finished scan job of the repository with the given outcome and finish time. */
async function finished(
  handle: DatabaseHandle,
  repositoryId: string,
  status: 'completed' | 'failed',
  result: Record<string, unknown>,
  finishedAt: string,
): Promise<string> {
  const jobId = await running(handle, repositoryId);
  await finishJob(handle.db, jobId, status, undefined, result);
  handle.sqlite.prepare('update jobs set finished_at = ? where id = ?').run(finishedAt, jobId);
  return jobId;
}

describe('getLastCompletedRepositoryScan (issue 63)', () => {
  it('returns the latest completed scan of that repository, not a later failure or another repository', async () => {
    const handle = getHandle();
    const a = await hosted(handle, 'a');
    const b = await hosted(handle, 'b');
    expect(await getLastCompletedRepositoryScan(handle.db, a)).toBeNull();

    await finished(handle, a, 'completed', success({ durationMs: 1 }), '2026-04-01T00:00:00.000Z');
    await finished(handle, a, 'completed', success({ durationMs: 2 }), '2026-04-03T00:00:00.000Z');
    await finished(handle, a, 'completed', success({ durationMs: 3 }), '2026-04-02T00:00:00.000Z');
    await finished(
      handle,
      a,
      'failed',
      { ok: false, code: 'unreachable', message: 'Could not reach github.com.' },
      '2026-04-04T00:00:00.000Z',
    );
    await finished(handle, b, 'completed', success({ durationMs: 5 }), '2026-04-05T00:00:00.000Z');

    expect(await getLastCompletedRepositoryScan(handle.db, a)).toMatchObject({
      ok: true,
      durationMs: 2,
      commitSha: COMMIT,
      scanConfigHash: HASH,
    });
    expect(await getLastCompletedRepositoryScan(handle.db, b)).toMatchObject({ durationMs: 5 });
  });

  it('parses a result stored before the configuration hash existed, without one', async () => {
    const handle = getHandle();
    const a = await hosted(handle);
    const { scanConfigHash: _omitted, ...old } = success();
    await finished(handle, a, 'completed', old, '2026-04-01T00:00:00.000Z');
    const last = await getLastCompletedRepositoryScan(handle.db, a);
    expect(last).toMatchObject({ ok: true, commitSha: COMMIT });
    expect(last?.scanConfigHash).toBeUndefined();
    expect(last?.unchanged).toBeUndefined();
  });

  it('returns null when the latest completed result does not parse as a successful scan', async () => {
    const handle = getHandle();
    const a = await hosted(handle);
    await finished(handle, a, 'completed', success(), '2026-04-01T00:00:00.000Z');
    const latest = await finished(handle, a, 'completed', success(), '2026-04-02T00:00:00.000Z');
    handle.sqlite
      .prepare('update jobs set result = ? where id = ?')
      .run(JSON.stringify(success({ scanConfigHash: 'not-a-hash' })), latest);
    expect(await getLastCompletedRepositoryScan(handle.db, a)).toBeNull();
    handle.sqlite
      .prepare('update jobs set result = ? where id = ?')
      .run(JSON.stringify({ ok: false, code: 'scan-failed', message: 'x' }), latest);
    expect(await getLastCompletedRepositoryScan(handle.db, a)).toBeNull();
  });
});

describe('recordUnchangedRepositoryScan (issue 63)', () => {
  /** A hosted repository scanned at COMMIT with three occurrences, and a running rescan job. */
  async function scannedRepository(handle: DatabaseHandle) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const repositoryId = await hosted(handle);
    const other = await hosted(handle, 'other');
    for (const id of [repositoryId, other]) {
      const jobId = await running(handle, id);
      await applyRepositoryScan(handle, {
        repositoryId: id,
        jobId,
        artifacts: [
          scanned('AGENTS.md', 'one'),
          scanned('a/AGENTS.md', 'two'),
          scanned('b/AGENTS.md', 'three'),
        ],
        unobserved: [],
        signal,
        commitSha: COMMIT,
      });
      await finishJob(handle.db, jobId, 'completed', undefined, success());
    }
    // One occurrence went missing, one is kept from an older commit (an unobserved path).
    handle.sqlite
      .prepare(
        `update artifact_occurrences set status = 'removed' where repository_id = ? and path = ?`,
      )
      .run(repositoryId, 'a/AGENTS.md');
    handle.sqlite
      .prepare(
        `update artifact_occurrences set commit_sha = ? where repository_id = ? and path = ?`,
      )
      .run(OTHER_COMMIT, repositoryId, 'b/AGENTS.md');
    const jobId = await running(handle, repositoryId);
    vi.setSystemTime(new Date('2026-04-02T00:00:00.000Z'));
    return { repositoryId, other, jobId };
  }

  function seenAt(handle: DatabaseHandle) {
    return handle.sqlite
      .prepare(
        `select r.name, o.path, o.last_seen_at as seen
           from artifact_occurrences o join repositories r on r.id = o.repository_id
          order by r.name, o.path`,
      )
      .all()
      .map((row) => `${String(row.name)}:${String(row.path)}@${String(row.seen).slice(0, 10)}`);
  }

  it('records a successful sync at the same commit and refreshes only the occurrences seen at it', async () => {
    const handle = getHandle();
    const { repositoryId, jobId } = await scannedRepository(handle);
    const versions = await handle.db.$count(schema.artifactVersions);
    handle.sqlite
      .prepare(`update repositories set sync_error = 'stale' where id = ?`)
      .run(repositoryId);

    expect(
      await recordUnchangedRepositoryScan(handle, {
        repositoryId,
        jobId,
        commitSha: COMMIT,
        signal,
      }),
    ).toBe(true);

    expect(await getRepository(handle.db, repositoryId)).toMatchObject({
      lastCommitSha: COMMIT,
      lastSyncAt: '2026-04-02T00:00:00.000Z',
      syncStatus: 'ok',
      syncError: null,
    });
    expect(seenAt(handle)).toEqual([
      'acme/other:AGENTS.md@2026-04-01',
      'acme/other:a/AGENTS.md@2026-04-01',
      'acme/other:b/AGENTS.md@2026-04-01',
      'acme/skills:AGENTS.md@2026-04-02',
      'acme/skills:a/AGENTS.md@2026-04-01',
      'acme/skills:b/AGENTS.md@2026-04-01',
    ]);
    expect(await handle.db.$count(schema.artifactVersions)).toBe(versions);
  });

  it('records nothing when the repository is no longer synced at that commit', async () => {
    const handle = getHandle();
    const { repositoryId, jobId } = await scannedRepository(handle);
    const before = await getRepository(handle.db, repositoryId);
    expect(
      await recordUnchangedRepositoryScan(handle, {
        repositoryId,
        jobId,
        commitSha: OTHER_COMMIT,
        signal,
      }),
    ).toBe(false);
    await handle.db
      .update(schema.repositories)
      .set({ syncStatus: 'error', syncError: 'failed' })
      .where(eq(schema.repositories.id, repositoryId));
    expect(
      await recordUnchangedRepositoryScan(handle, {
        repositoryId,
        jobId,
        commitSha: COMMIT,
        signal,
      }),
    ).toBe(false);
    expect(await getRepository(handle.db, repositoryId)).toMatchObject({
      lastSyncAt: before?.lastSyncAt,
      syncStatus: 'error',
    });
    expect(seenAt(handle).filter((row) => row.endsWith('2026-04-02'))).toEqual([]);
  });

  it('throws for a removed repository and for a job that is no longer running', async () => {
    const handle = getHandle();
    const { repositoryId, jobId } = await scannedRepository(handle);
    const aborted = new AbortController();
    aborted.abort('cancelled');
    await expect(
      recordUnchangedRepositoryScan(handle, {
        repositoryId,
        jobId,
        commitSha: COMMIT,
        signal: aborted.signal,
      }),
    ).rejects.toBeInstanceOf(JobNoLongerRunningError);
    await requestJobCancellation(handle.db, jobId);
    await expect(
      recordUnchangedRepositoryScan(handle, { repositoryId, jobId, commitSha: COMMIT, signal }),
    ).rejects.toBeInstanceOf(JobNoLongerRunningError);
    const next = await hosted(handle, 'next');
    const nextJob = await running(handle, next);
    await finishJob(handle.db, nextJob, 'cancelled');
    await expect(
      recordUnchangedRepositoryScan(handle, {
        repositoryId: next,
        jobId: nextJob,
        commitSha: COMMIT,
        signal,
      }),
    ).rejects.toBeInstanceOf(JobNoLongerRunningError);
    const gone = await hosted(handle, 'gone');
    const goneJob = await running(handle, gone);
    handle.sqlite.prepare('delete from repositories where id = ?').run(gone);
    await expect(
      recordUnchangedRepositoryScan(handle, {
        repositoryId: gone,
        jobId: goneJob,
        commitSha: COMMIT,
        signal,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await getRepository(handle.db, repositoryId)).toMatchObject({
      lastSyncAt: '2026-04-01T00:00:00.000Z',
    });
  });
});
