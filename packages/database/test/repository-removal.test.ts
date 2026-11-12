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
  getRepository,
  getRepositoryRemovalImpact,
  importArtifactVersion,
  importSuiteVersion,
  listArtifacts,
  removeRepository,
  schema,
  seedPredefinedCategories,
  setArtifactNotes,
  upsertRepository,
  type DatabaseHandle,
  type ScannedArtifactInput,
} from '../src/index';
import { artifactInput, registerLocal, seedRun, suiteInput } from './support/fixtures';
import { openTestDatabase, useTestDatabase, type TestDatabase } from './support/test-database';
import { expectLinearTime, LINEAR_TIME_TEST_TIMEOUT_MS } from '../../../test-support/linear-time';

// SPEC-125 Phase 2: removing a repository deletes its occurrences in one transaction and keeps
// its artifacts, versions and their history; `bundled-examples` cannot be removed.

const getHandle = useTestDatabase();
const signal = new AbortController().signal;

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

/** Registers a local repository and applies one complete scan of `artifacts` to it. */
async function scannedRepository(
  handle: DatabaseHandle,
  location: string,
  artifacts: ScannedArtifactInput[],
) {
  const { repository } = await registerLocal(handle, { location, name: location.slice(1) });
  const scan = async (found: ScannedArtifactInput[]) => {
    const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
    await acquireNextJob(handle.db, 'runner');
    return applyRepositoryScan(handle, {
      repositoryId: repository.id,
      jobId: job.id,
      artifacts: found,
      unobserved: [],
      commitSha: null,
      signal,
    });
  };
  await scan(artifacts);
  return { repositoryId: repository.id, scan };
}

async function occurrences(handle: DatabaseHandle, repositoryId: string) {
  return handle.db
    .select()
    .from(schema.artifactOccurrences)
    .where(eq(schema.artifactOccurrences.repositoryId, repositoryId))
    .orderBy(schema.artifactOccurrences.path);
}

/** Points one more occurrence in `repositoryId` at an existing artifact, as cross-repository identity would. */
async function shareArtifact(
  handle: DatabaseHandle,
  artifactId: string,
  repositoryId: string,
  path: string,
  status: 'active' | 'removed',
) {
  handle.sqlite
    .prepare(
      `insert into artifact_occurrences
         (id, artifact_id, repository_id, path, status, latest_version_id, last_seen_at, created_at, updated_at)
       select ?, ?, ?, ?, ?, id, 't', 't', 't' from artifact_versions where artifact_id = ? limit 1`,
    )
    .run(`occ_${path}`, artifactId, repositoryId, path, status, artifactId);
}

function count(handle: DatabaseHandle, table: string): number {
  return Number(
    (handle.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n,
  );
}

describe('getRepositoryRemovalImpact (SPEC-125 FR-125-13)', () => {
  it('counts all occurrences, the active ones and the artifacts left missing everywhere', async () => {
    const handle = getHandle();
    const a = await scannedRepository(handle, '/srv/a', [
      scanned('AGENTS.md', 'one'),
      scanned('CLAUDE.md', 'two'),
      scanned('rules/x.md', 'three'),
    ]);
    // One occurrence goes missing: it still counts as an occurrence, not as left missing.
    await a.scan([scanned('AGENTS.md', 'one'), scanned('CLAUDE.md', 'two')]);
    const b = await scannedRepository(handle, '/srv/b', [scanned('AGENTS.md', 'other')]);
    const [agents, claude] = await occurrences(handle, a.repositoryId);
    // CLAUDE.md's artifact is also active in b, so it does not become missing.
    await shareArtifact(handle, claude?.artifactId ?? '', b.repositoryId, 'shared', 'active');
    // AGENTS.md's artifact also has a missing occurrence in b, which does not keep it active.
    await shareArtifact(handle, agents?.artifactId ?? '', b.repositoryId, 'gone', 'removed');

    expect(await getRepositoryRemovalImpact(handle.db, a.repositoryId)).toEqual({
      id: a.repositoryId,
      name: 'srv/a',
      provider: 'local-directory',
      location: '/srv/a',
      occurrences: 3,
      activeOccurrences: 2,
      artifactsLeftMissing: 1,
    });
  });

  it('reports zero counts for a repository without occurrences', async () => {
    const handle = getHandle();
    const { repository } = await registerLocal(handle, { location: '/srv/empty', name: 'empty' });
    expect(await getRepositoryRemovalImpact(handle.db, repository.id)).toMatchObject({
      occurrences: 0,
      activeOccurrences: 0,
      artifactsLeftMissing: 0,
    });
  });

  it('is null for an unknown id and for the bundled-examples repository (A15)', async () => {
    const handle = getHandle();
    const bundled = await upsertRepository(handle.db, {
      provider: 'bundled-examples',
      name: 'Bundled examples',
      location: '/opt/examples',
    });
    expect(await getRepositoryRemovalImpact(handle.db, 'repo_unknown')).toBeNull();
    expect(await getRepositoryRemovalImpact(handle.db, bundled)).toBeNull();
  });
});

describe('removeRepository (SPEC-125 FR-125-14, AC-3)', () => {
  it('deletes the repository and its occurrences and keeps artifacts, versions and their history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-01T00:00:00.000Z'));
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const a = await scannedRepository(handle, '/srv/a', [
      scanned('AGENTS.md', 'one'),
      scanned('CLAUDE.md', 'two'),
    ]);
    const b = await scannedRepository(handle, '/srv/b', [scanned('AGENTS.md', 'kept')]);
    const [agents, claude] = await occurrences(handle, a.repositoryId);
    const artifactId = agents?.artifactId ?? '';
    await shareArtifact(handle, claude?.artifactId ?? '', b.repositoryId, 'shared', 'active');
    const { suiteId, versionId: suiteVersionId } = await importSuiteVersion(
      handle,
      suiteInput('h'),
    );
    await addArtifactTag(handle, artifactId, 'security');
    await setArtifactNotes(handle.db, artifactId, 'Checked in client A.');
    await assignArtifactSuite(handle, artifactId, suiteId);
    await assignCategoriesBySlug(handle.db, artifactId, ['security']);
    const runId = await seedRun(handle, {
      artifactVersionId: agents?.latestVersionId ?? '',
      suiteVersionId,
    });
    const artifactsBefore = count(handle, 'artifacts');
    const versionsBefore = count(handle, 'artifact_versions');

    expect(await removeRepository(handle, a.repositoryId)).toEqual({
      status: 'removed',
      occurrences: 2,
      artifactsLeftMissing: 1,
    });

    expect(await getRepository(handle.db, a.repositoryId)).toBeNull();
    expect(await occurrences(handle, a.repositoryId)).toEqual([]);
    // b and its occurrences are untouched.
    expect((await occurrences(handle, b.repositoryId)).map((o) => o.path)).toEqual([
      'AGENTS.md',
      'shared',
    ]);
    expect(count(handle, 'artifacts')).toBe(artifactsBefore);
    expect(count(handle, 'artifact_versions')).toBe(versionsBefore);
    const sources = handle.sqlite
      .prepare('select source_repository_id as source from artifact_versions where artifact_id = ?')
      .all(artifactId) as { source: string | null }[];
    expect(sources).toEqual([{ source: null }]);

    // AC-3: the artifact keeps its version, metadata and results and is missing with no
    // occurrence left (FR-125-17).
    const detail = await getArtifactDetail(handle.db, artifactId);
    expect(detail).toMatchObject({
      missing: true,
      lastFoundAt: null,
      occurrences: [],
      artifact: { tags: ['security'], notes: 'Checked in client A.' },
      suites: [{ id: suiteId }],
      categories: [{ slug: 'security' }],
      evaluations: [{ runId }],
    });
    expect(detail?.versions.map((v) => v.version)).toEqual([1]);
    // The artifact also found in b stays active.
    const listed = await listArtifacts(handle.db);
    expect(listed.find((x) => x.id === claude?.artifactId)).toMatchObject({ missing: false });
    expect(listed.find((x) => x.id === artifactId)).toMatchObject({
      missing: true,
      occurrenceCount: 0,
    });

    // A second call finds nothing to remove.
    expect(await removeRepository(handle, a.repositoryId)).toEqual({ status: 'not-found' });
  });

  it('counts already missing occurrences as deleted but not as left missing', async () => {
    const handle = getHandle();
    const a = await scannedRepository(handle, '/srv/a', [
      scanned('AGENTS.md', 'one'),
      scanned('CLAUDE.md', 'two'),
    ]);
    await a.scan([scanned('AGENTS.md', 'one')]);
    expect(await removeRepository(handle, a.repositoryId)).toEqual({
      status: 'removed',
      occurrences: 2,
      artifactsLeftMissing: 1,
    });
  });

  it('after an empty scan kept the only artifact, removal leaves it missing with its history (AC-10)', async () => {
    const handle = getHandle();
    const a = await scannedRepository(handle, '/srv/a', [scanned('AGENTS.md', 'only')]);
    const [occurrence] = await occurrences(handle, a.repositoryId);
    expect(await a.scan([])).toMatchObject({ emptyScanKeptOccurrences: 1, removedOccurrences: 0 });
    expect(await getArtifactDetail(handle.db, occurrence?.artifactId ?? '')).toMatchObject({
      missing: false,
    });

    expect(await removeRepository(handle, a.repositoryId)).toEqual({
      status: 'removed',
      occurrences: 1,
      artifactsLeftMissing: 1,
    });
    const detail = await getArtifactDetail(handle.db, occurrence?.artifactId ?? '');
    expect(detail).toMatchObject({ missing: true, lastFoundAt: null });
    expect(detail?.versions).toHaveLength(1);
  });

  it('refuses the bundled-examples repository and an unknown id without writing', async () => {
    const handle = getHandle();
    const imported = await importArtifactVersion(
      handle,
      artifactInput('v1', {
        repository: {
          provider: 'bundled-examples',
          name: 'Bundled examples',
          location: '/opt/examples',
        },
      }),
    );
    const bundled = handle.sqlite
      .prepare("select id from repositories where provider = 'bundled-examples'")
      .get() as { id: string };
    expect(await removeRepository(handle, bundled.id)).toEqual({ status: 'not-removable' });
    expect(await removeRepository(handle, 'repo_unknown')).toEqual({ status: 'not-found' });
    expect(count(handle, 'repositories')).toBe(1);
    expect(count(handle, 'artifact_occurrences')).toBe(1);
    expect(await getArtifactDetail(handle.db, imported.artifactId)).toMatchObject({
      missing: false,
    });
  });

  it('rolls everything back when a statement inside the transaction fails', async () => {
    const handle = getHandle();
    const a = await scannedRepository(handle, '/srv/a', [scanned('AGENTS.md', 'one')]);
    // The cascade runs inside the delete, so a failing occurrence delete aborts the whole removal.
    handle.sqlite.exec(
      "CREATE TRIGGER fail_occurrences BEFORE DELETE ON artifact_occurrences BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await expect(removeRepository(handle, a.repositoryId)).rejects.toThrow(/Failed query: delete/);
    expect(await getRepository(handle.db, a.repositoryId)).not.toBeNull();
    expect(await occurrences(handle, a.repositoryId)).toHaveLength(1);
    const versions = handle.sqlite
      .prepare('select source_repository_id as source from artifact_versions')
      .all() as { source: string | null }[];
    expect(versions).toEqual([{ source: a.repositoryId }]);
  });
});

describe('removal impact cost (Codex review of PR #217)', () => {
  /**
   * A catalog of `size` artifacts in the target repository (every second one also active in a
   * second repository) and `size` unrelated artifacts in a third, written with raw SQL so building
   * it stays fast. A correlated "active elsewhere?" lookup per artifact scanned every occurrence
   * again for each one: quadratic, inside the removal's write transaction.
   */
  async function catalog(size: number): Promise<TestDatabase & { target: string }> {
    const database = await openTestDatabase();
    const { sqlite } = database.handle;
    const repository = sqlite.prepare(
      `insert into repositories (id, provider, name, location, created_at, updated_at)
       values (?, 'local-directory', ?, ?, 't', 't')`,
    );
    const artifact = sqlite.prepare(
      `insert into artifacts (id, slug, name, type, created_at, updated_at)
       values (?, ?, ?, 'rule', 't', 't')`,
    );
    const version = sqlite.prepare(
      `insert into artifact_versions (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
       values (?, ?, 1, 'h', 'agents-md', 'AGENTS.md', '[]', '{}', 't')`,
    );
    const occurrence = sqlite.prepare(
      `insert into artifact_occurrences (id, artifact_id, repository_id, path, latest_version_id, status, last_seen_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, 'active', 't', 't', 't')`,
    );
    sqlite.exec('BEGIN');
    for (const id of ['repo_target', 'repo_shared', 'repo_other']) repository.run(id, id, `/${id}`);
    for (let i = 0; i < 2 * size; i += 1) {
      const id = `art_${i}`;
      artifact.run(id, id, id);
      version.run(`ver_${i}`, id);
      const home = i < size ? 'repo_target' : 'repo_other';
      occurrence.run(`occ_${i}`, id, home, `p${i}`, `ver_${i}`);
      if (i < size && i % 2 === 0)
        occurrence.run(`occ_shared_${i}`, id, 'repo_shared', `p${i}`, `ver_${i}`);
    }
    sqlite.exec('COMMIT');
    return { ...database, target: 'repo_target' };
  }

  it(
    'grows linearly with the catalog',
    async () => {
      const built: TestDatabase[] = [];
      const build = async (size: number) => {
        const database = await catalog(size);
        built.push(database);
        return database;
      };
      try {
        // Half of the target's artifacts are also active in another repository.
        const small = await build(10);
        expect(await getRepositoryRemovalImpact(small.handle.db, small.target)).toMatchObject({
          occurrences: 10,
          activeOccurrences: 10,
          artifactsLeftMissing: 5,
        });
        await expectLinearTime({
          build,
          run: (database) => getRepositoryRemovalImpact(database.handle.db, database.target),
          // Reading every occurrence row once is linear in the same data.
          // (awaited: a Drizzle query only runs when awaited).
          baseline: async (database) =>
            await database.handle.db
              .select({ id: schema.artifactOccurrences.id, path: schema.artifactOccurrences.path })
              .from(schema.artifactOccurrences),
          size: 3_200,
        });
      } finally {
        for (const database of built) database.dispose();
      }
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );
});
