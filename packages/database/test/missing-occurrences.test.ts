import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireNextJob,
  addArtifactTag,
  applyRepositoryScan,
  assignArtifactSuite,
  assignCategoriesBySlug,
  enqueueRepositoryScanJob,
  getArtifactDetail,
  importArtifactVersion,
  importSuiteVersion,
  JobNoLongerRunningError,
  listArtifacts,
  NotFoundError,
  REMOVED_OCCURRENCE_BATCH_SIZE,
  repositoryScanResultSchema,
  requestJobCancellation,
  schema,
  seedPredefinedCategories,
  setArtifactNotes,
  type DatabaseHandle,
  type ScannedArtifactInput,
} from '../src/index';
import { artifactInput, registerLocal, seedRun, suiteInput } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

// SPEC-125 Phase 1: a complete scan marks what it did not find as `removed` (shown as missing),
// keeps what it could not observe, marks nothing when it found nothing (A7), and reactivates.

const getHandle = useTestDatabase();
const signal = new AbortController().signal;
/** Inserting 10,000 occurrences and marking them takes well under a second locally. */
const MANY_OCCURRENCES_TIMEOUT_MS = 30_000;

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

/** Registers a repository and holds a running scan job for it, as the runner would. */
async function runningScan(handle: DatabaseHandle, location: string, name = 'repo') {
  const { repository } = await registerLocal(handle, { location, name });
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
  await acquireNextJob(handle.db, 'runner');
  return { repositoryId: repository.id, jobId: job.id };
}

function scanWith(handle: DatabaseHandle, scan: { repositoryId: string; jobId: string }) {
  return (artifacts: ScannedArtifactInput[], unobserved: string[] = []) =>
    applyRepositoryScan(handle, { ...scan, artifacts, unobserved, signal, commitSha: null });
}

async function occurrencesOf(handle: DatabaseHandle, repositoryId: string) {
  return handle.db
    .select()
    .from(schema.artifactOccurrences)
    .where(eq(schema.artifactOccurrences.repositoryId, repositoryId))
    .orderBy(schema.artifactOccurrences.path);
}

async function statusByPath(handle: DatabaseHandle, repositoryId: string) {
  return (await occurrencesOf(handle, repositoryId)).map((o) => [o.path, o.status]);
}

describe('applyRepositoryScan marks missing occurrences (SPEC-125)', () => {
  it('marks unseen active occurrences of the scanned repository only, keeping their history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const a = await runningScan(handle, '/srv/a');
    const b = await runningScan(handle, '/srv/b');
    await scanWith(handle, a)([scanned('AGENTS.md', 'v1'), scanned('x/AGENTS.md', 'v1')]);
    await scanWith(handle, b)([scanned('x/AGENTS.md', 'v1')]);
    const [, before] = await occurrencesOf(handle, a.repositoryId);

    vi.setSystemTime(new Date('2026-04-02T00:00:00.000Z'));
    expect(await scanWith(handle, a)([scanned('AGENTS.md', 'v1')])).toEqual({
      createdArtifacts: 0,
      createdVersions: 0,
      removedOccurrences: 1,
      reactivatedOccurrences: 0,
      emptyScanKeptOccurrences: 0,
      linkedOccurrences: 0,
      ambiguousLinks: 0,
    });
    const [, after] = await occurrencesOf(handle, a.repositoryId);
    expect(after).toEqual({
      ...before,
      status: 'removed',
      updatedAt: '2026-04-02T00:00:00.000Z',
    });
    expect(after?.lastSeenAt).toBe('2026-04-01T00:00:00.000Z');
    // The other repository's occurrence at the same path is untouched.
    expect(await statusByPath(handle, b.repositoryId)).toEqual([['x/AGENTS.md', 'active']]);
    // A second scan does not count it again, and nothing was deleted.
    expect(await scanWith(handle, a)([scanned('AGENTS.md', 'v1')])).toMatchObject({
      removedOccurrences: 0,
    });
    expect(await handle.db.$count(schema.artifacts)).toBe(3);
    expect(await handle.db.$count(schema.artifactVersions)).toBe(3);
  });

  it('marks nothing when the scan found no artifact (empty-scan guard, A7), and marks once one is found', async () => {
    const handle = getHandle();
    const scan = await runningScan(handle, '/srv/a');
    const apply = scanWith(handle, scan);
    await apply([scanned('AGENTS.md', 'v1'), scanned('x/AGENTS.md', 'v1')]);

    expect(await apply([])).toEqual({
      createdArtifacts: 0,
      createdVersions: 0,
      removedOccurrences: 0,
      reactivatedOccurrences: 0,
      emptyScanKeptOccurrences: 2,
      linkedOccurrences: 0,
      ambiguousLinks: 0,
    });
    expect(await statusByPath(handle, scan.repositoryId)).toEqual([
      ['AGENTS.md', 'active'],
      ['x/AGENTS.md', 'active'],
    ]);
    const repository = await handle.db
      .select({ syncStatus: schema.repositories.syncStatus })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, scan.repositoryId))
      .get();
    expect(repository?.syncStatus).toBe('ok');

    expect(await apply([scanned('AGENTS.md', 'v1')])).toMatchObject({
      removedOccurrences: 1,
      emptyScanKeptOccurrences: 0,
      linkedOccurrences: 0,
      ambiguousLinks: 0,
    });
    expect(await statusByPath(handle, scan.repositoryId)).toEqual([
      ['AGENTS.md', 'active'],
      ['x/AGENTS.md', 'removed'],
    ]);
    // Only active occurrences count as kept.
    expect(await apply([])).toMatchObject({ emptyScanKeptOccurrences: 1 });
  });

  it('keeps occurrences equal to, inside or containing an unobserved path', async () => {
    const handle = getHandle();
    const scan = await runningScan(handle, '/srv/a');
    const apply = scanWith(handle, scan);
    await apply([
      scanned('AGENTS.md', 'v1'),
      scanned('a', 'v1'),
      scanned('a/b/c', 'v1'),
      scanned('err/CLAUDE.md', 'v1'),
      scanned('gone', 'v1'),
      scanned('ab', 'v1'),
    ]);
    const summary = await apply(
      [scanned('AGENTS.md', 'v1')],
      ['a/b', 'err/CLAUDE.md', 'ab-unrelated'],
    );
    expect(summary.removedOccurrences).toBe(2);
    expect(await statusByPath(handle, scan.repositoryId)).toEqual([
      ['AGENTS.md', 'active'],
      ['a', 'active'],
      ['a/b/c', 'active'],
      ['ab', 'removed'],
      ['err/CLAUDE.md', 'active'],
      ['gone', 'removed'],
    ]);
  });

  it('reactivates a missing occurrence with equal and with changed content, keeping metadata and runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const scan = await runningScan(handle, '/srv/a');
    const apply = scanWith(handle, scan);
    await apply([scanned('AGENTS.md', 'keep'), scanned('skill', 'v1')]);
    const [, occurrence] = await occurrencesOf(handle, scan.repositoryId);
    const artifactId = occurrence?.artifactId ?? '';
    const { suiteId, versionId: suiteVersionId } = await importSuiteVersion(
      handle,
      suiteInput('h'),
    );
    await addArtifactTag(handle, artifactId, 'security');
    await setArtifactNotes(handle.db, artifactId, 'Checked in client A.');
    await assignArtifactSuite(handle, artifactId, suiteId);
    await assignCategoriesBySlug(handle.db, artifactId, ['security']);
    const runId = await seedRun(handle, {
      artifactVersionId: occurrence?.latestVersionId ?? '',
      suiteVersionId,
    });

    vi.setSystemTime(new Date('2026-04-02T00:00:00.000Z'));
    await apply([scanned('AGENTS.md', 'keep')]);
    const missing = await getArtifactDetail(handle.db, artifactId);
    // AC-2: still listed and complete, labelled missing, last found when it was last seen.
    expect(missing).toMatchObject({
      missing: true,
      lastFoundAt: '2026-04-01T00:00:00.000Z',
      artifact: { tags: ['security'], notes: 'Checked in client A.' },
      suites: [{ id: suiteId }],
      categories: [{ slug: 'security' }],
      evaluations: [{ runId }],
    });
    expect(missing?.versions.map((v) => v.version)).toEqual([1]);
    const listed = await listArtifacts(handle.db);
    expect(listed.find((a) => a.id === artifactId)).toMatchObject({
      missing: true,
      occurrenceCount: 0,
      repositories: [],
    });

    // Found again with equal content: same occurrence and artifact, no new version.
    vi.setSystemTime(new Date('2026-04-03T00:00:00.000Z'));
    expect(await apply([scanned('AGENTS.md', 'keep'), scanned('skill', 'v1')])).toEqual({
      createdArtifacts: 0,
      createdVersions: 0,
      removedOccurrences: 0,
      reactivatedOccurrences: 1,
      emptyScanKeptOccurrences: 0,
      linkedOccurrences: 0,
      ambiguousLinks: 0,
    });
    const [, back] = await occurrencesOf(handle, scan.repositoryId);
    expect(back).toMatchObject({
      id: occurrence?.id,
      artifactId,
      status: 'active',
      latestVersionId: occurrence?.latestVersionId,
      lastSeenAt: '2026-04-03T00:00:00.000Z',
    });
    expect(await getArtifactDetail(handle.db, artifactId)).toMatchObject({
      missing: false,
      lastFoundAt: null,
    });

    // Missing again, then found with other content: the next version.
    await apply([scanned('AGENTS.md', 'keep')]);
    expect(await apply([scanned('AGENTS.md', 'keep'), scanned('skill', 'v2')])).toMatchObject({
      createdVersions: 1,
      reactivatedOccurrences: 1,
    });
    const detail = await getArtifactDetail(handle.db, artifactId);
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail).toMatchObject({
      missing: false,
      artifact: { tags: ['security'], notes: 'Checked in client A.' },
      suites: [{ id: suiteId }],
      categories: [{ slug: 'security' }],
      evaluations: [{ runId }],
    });
  });

  it('reports the latest last-seen date of an artifact missing from several repositories', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = getHandle();
    // Scans never share an artifact across repositories (location identity), so point the second
    // occurrence at the first one's artifact. Names order the newer occurrence first.
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const older = await runningScan(handle, '/srv/z', 'z-older');
    await scanWith(handle, older)([scanned('AGENTS.md', 'x'), scanned('keep', 'x')]);
    vi.setSystemTime(new Date('2026-04-05T00:00:00.000Z'));
    const newer = await runningScan(handle, '/srv/a', 'a-newer');
    await scanWith(handle, newer)([scanned('AGENTS.md', 'x'), scanned('keep', 'x')]);
    const [first] = await occurrencesOf(handle, older.repositoryId);
    const [second] = await occurrencesOf(handle, newer.repositoryId);
    const artifactId = first?.artifactId ?? '';
    await handle.db
      .update(schema.artifactOccurrences)
      .set({ artifactId })
      .where(eq(schema.artifactOccurrences.id, second?.id ?? ''));

    await scanWith(handle, older)([scanned('keep', 'x')]);
    expect(await getArtifactDetail(handle.db, artifactId)).toMatchObject({
      missing: false,
      lastFoundAt: null,
    });
    await scanWith(handle, newer)([scanned('keep', 'x')]);
    const detail = await getArtifactDetail(handle.db, artifactId);
    expect(detail?.occurrences.map((o) => o.repository.name)).toEqual(['a-newer', 'z-older']);
    expect(detail).toMatchObject({ missing: true, lastFoundAt: '2026-04-05T00:00:00.000Z' });
  });

  it('never marks anything when a bundled example import runs (A22)', async () => {
    const handle = getHandle();
    await importArtifactVersion(handle, artifactInput('v1'));
    await importArtifactVersion(handle, artifactInput('v1', { slug: 'other', name: 'Other' }));
    await importArtifactVersion(handle, artifactInput('v2'));
    const rows = await handle.db.select().from(schema.artifactOccurrences);
    expect(rows.every((row) => row.status === 'active')).toBe(true);
  });

  it('marks nothing when the job was cancelled, the signal aborted or the repository removed', async () => {
    const handle = getHandle();
    const scan = await runningScan(handle, '/srv/a');
    await scanWith(handle, scan)([scanned('AGENTS.md', 'x'), scanned('gone', 'x')]);
    const aborted = new AbortController();
    aborted.abort('shutdown');
    await expect(
      applyRepositoryScan(handle, {
        ...scan,
        artifacts: [scanned('AGENTS.md', 'x')],
        unobserved: [],
        signal: aborted.signal,
        commitSha: null,
      }),
    ).rejects.toThrow(JobNoLongerRunningError);
    await requestJobCancellation(handle.db, scan.jobId);
    await expect(scanWith(handle, scan)([scanned('AGENTS.md', 'x')])).rejects.toThrow(
      JobNoLongerRunningError,
    );
    expect(await statusByPath(handle, scan.repositoryId)).toEqual([
      ['AGENTS.md', 'active'],
      ['gone', 'active'],
    ]);

    const other = await runningScan(handle, '/srv/b');
    handle.sqlite.exec(`delete from repositories where id = '${other.repositoryId}'`);
    await expect(scanWith(handle, other)([scanned('AGENTS.md', 'x')])).rejects.toThrow(
      NotFoundError,
    );
  });

  it('rolls the marking back when a later statement of the transaction fails', async () => {
    const handle = getHandle();
    const scan = await runningScan(handle, '/srv/a');
    await scanWith(handle, scan)([scanned('AGENTS.md', 'x'), scanned('gone', 'x')]);
    // The repository status update runs after the marking (lesson 2026-11-05: a real failure).
    handle.sqlite.exec(`
      create trigger refuse_status before update on repositories
      begin select raise(abort, 'refused by trigger'); end;
    `);
    const failure = await scanWith(
      handle,
      scan,
    )([scanned('AGENTS.md', 'x')]).catch((error: unknown) => error);
    handle.sqlite.exec('drop trigger refuse_status');
    expect(failure).toHaveProperty('cause.message', 'refused by trigger');
    expect(await statusByPath(handle, scan.repositoryId)).toEqual([
      ['AGENTS.md', 'active'],
      ['gone', 'active'],
    ]);
  });

  it(
    'marks 10,000 unseen occurrences in batches (NFR-125-02)',
    async () => {
      const handle = getHandle();
      const scan = await runningScan(handle, '/srv/a');
      await scanWith(handle, scan)([scanned('AGENTS.md', 'x')]);
      const [kept] = await occurrencesOf(handle, scan.repositoryId);
      // 10,000 more occurrences of one artifact, inserted directly: storing them through scans
      // would measure the writer, not the marking.
      handle.sqlite.exec(`
        with recursive n(i) as (select 1 union all select i + 1 from n where i < 10000)
        insert into artifact_occurrences
          (id, artifact_id, repository_id, path, latest_version_id, status, last_seen_at,
           created_at, updated_at)
        select 'occ_bulk_' || i, '${kept?.artifactId}', '${scan.repositoryId}', 'bulk/' || i,
          '${kept?.latestVersionId}', 'active', '2026-01-01', '2026-01-01', '2026-01-01'
        from n;
      `);
      const prepare = vi.spyOn(handle.sqlite, 'prepare');
      const summary = await scanWith(handle, scan)([scanned('AGENTS.md', 'x')]);
      const updates = prepare.mock.calls.filter(([query]) =>
        query.startsWith('update "artifact_occurrences" set "status"'),
      );
      prepare.mockRestore();
      expect(summary.removedOccurrences).toBe(10_000);
      expect(updates).toHaveLength(Math.ceil(10_000 / REMOVED_OCCURRENCE_BATCH_SIZE));
      const statuses = await handle.db
        .select({ status: schema.artifactOccurrences.status })
        .from(schema.artifactOccurrences);
      expect(statuses.filter((row) => row.status === 'removed')).toHaveLength(10_000);
    },
    MANY_OCCURRENCES_TIMEOUT_MS,
  );
});

describe('repositoryScanResultSchema SPEC-125 counts', () => {
  it('parses a result stored before the counts existed with 0', () => {
    const stored = {
      ok: true,
      scannedFiles: 1,
      discovered: 1,
      createdArtifacts: 0,
      createdVersions: 0,
      warningCount: 0,
      errorCount: 0,
      errors: [],
      durationMs: 5,
    };
    expect(repositoryScanResultSchema.parse(stored)).toMatchObject({
      removedOccurrences: 0,
      reactivatedOccurrences: 0,
      emptyScanKeptOccurrences: 0,
      linkedOccurrences: 0,
      ambiguousLinks: 0,
    });
    expect(
      repositoryScanResultSchema.parse({
        ...stored,
        removedOccurrences: 2,
        reactivatedOccurrences: 1,
        emptyScanKeptOccurrences: 0,
        linkedOccurrences: 0,
        ambiguousLinks: 0,
      }),
    ).toMatchObject({ removedOccurrences: 2, reactivatedOccurrences: 1 });
    expect(() => repositoryScanResultSchema.parse({ ...stored, removedOccurrences: -1 })).toThrow();
  });
});
