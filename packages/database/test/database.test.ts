import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireNextJob,
  assignCategoriesBySlug,
  enqueueBenchmarkJob,
  finishJob,
  getArtifactBundle,
  getArtifactDetail,
  getDashboardStats,
  heartbeatJob,
  importArtifactVersion,
  importSuiteVersion,
  listArtifacts,
  listCategories,
  migrateDatabase,
  openDatabase,
  recoverStaleJobs,
  requestJobCancellation,
  seedPredefinedCategories,
  type DatabaseHandle,
  type ImportArtifactInput,
} from '../src/index';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

function artifactInput(content: string): ImportArtifactInput {
  return {
    repository: { provider: 'local-directory', name: 'fixtures', location: '/tmp/fixtures' },
    path: 'skills/validate',
    slug: 'validate',
    name: 'validate',
    type: 'skill',
    description: 'Validate input',
    format: 'skill-md',
    primaryFile: 'SKILL.md',
    files: [{ path: 'SKILL.md', sha256: content, size: content.length, content }],
    contentHash: `hash-${content}`,
    parsedMetadata: {},
  };
}

let handle: DatabaseHandle;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'directivebench-db-'));
  handle = openDatabase(join(dir, 'test.db'));
  await migrateDatabase(handle, migrationsFolder);
});

afterEach(() => handle.close());

describe('migrations', () => {
  it('creates the schema and is idempotent', async () => {
    const second = await migrateDatabase(handle, migrationsFolder);
    expect(second.applied).toBe(0);
    const tables = handle.sqlite
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'artifacts',
        'artifact_versions',
        'jobs',
        'benchmark_runs',
        'assertion_results',
      ]),
    );
    expect(handle.sqlite.prepare('pragma journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });
});

describe('artifacts', () => {
  it('creates immutable versions only for new content and preserves user metadata', async () => {
    await seedPredefinedCategories(handle.db);
    const first = await importArtifactVersion(handle, artifactInput('v1'));
    expect(first).toMatchObject({ version: 1, createdVersion: true });
    await assignCategoriesBySlug(handle.db, first.artifactId, ['security', 'nope']);

    const same = await importArtifactVersion(handle, artifactInput('v1'));
    expect(same).toMatchObject({ versionId: first.versionId, createdVersion: false });

    const second = await importArtifactVersion(handle, artifactInput('v2'));
    expect(second).toMatchObject({
      artifactId: first.artifactId,
      version: 2,
      createdVersion: true,
    });

    const detail = await getArtifactDetail(handle.db, first.artifactId);
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail?.categories.map((c) => c.slug)).toEqual(['security']);
    expect(detail?.occurrences).toHaveLength(1);
    expect(detail?.occurrences[0]?.occurrence.latestVersionId).toBe(second.versionId);

    const bundle = await getArtifactBundle(handle.db, first.versionId);
    expect(bundle?.files[0]?.content).toBe('v1');

    const list = await listArtifacts(handle.db);
    expect(list[0]).toMatchObject({
      latestVersion: 2,
      sources: ['fixtures'],
      latestEvaluation: null,
    });
  });

  it('seeds predefined categories once', async () => {
    expect(await seedPredefinedCategories(handle.db)).toBe(17);
    expect(await seedPredefinedCategories(handle.db)).toBe(0);
    expect(await listCategories(handle.db)).toHaveLength(17);
  });
});

describe('jobs', () => {
  async function seedJobTargets() {
    const artifact = await importArtifactVersion(handle, artifactInput('v1'));
    const suite = await importSuiteVersion(handle, {
      slug: 'suite',
      name: 'Suite',
      description: null,
      schemaVersion: 1,
      definition: { id: 'suite' },
      fixtures: {},
      contentHash: 'h',
      sourcePath: null,
      approval: null,
    });
    return { suiteVersionId: suite.versionId, artifactVersionId: artifact.versionId };
  }

  it('acquires each pending job exactly once in FIFO order', async () => {
    const payload = await seedJobTargets();
    const a = await enqueueBenchmarkJob(handle.db, payload);
    const b = await enqueueBenchmarkJob(handle.db, payload);
    const [first, second, none] = await Promise.all([
      acquireNextJob(handle.db, 'r1'),
      acquireNextJob(handle.db, 'r2'),
      acquireNextJob(handle.db, 'r3'),
    ]);
    expect(new Set([first?.id, second?.id])).toEqual(new Set([a.id, b.id]));
    expect(none).toBeNull();
    expect(first?.attempts).toBe(1);
  });

  it('rejects jobs referencing unknown versions', async () => {
    await expect(
      enqueueBenchmarkJob(handle.db, { suiteVersionId: 'x', artifactVersionId: 'y' }),
    ).rejects.toThrow(/not found/);
  });

  it('cancels pending jobs immediately and flags running ones', async () => {
    const payload = await seedJobTargets();
    const pending = await enqueueBenchmarkJob(handle.db, payload);
    expect(await requestJobCancellation(handle.db, pending.id)).toBe('cancelled');
    expect(await acquireNextJob(handle.db, 'r')).toBeNull();

    const running = await enqueueBenchmarkJob(handle.db, payload);
    await acquireNextJob(handle.db, 'r');
    expect(await requestJobCancellation(handle.db, running.id)).toBe('running');
    await finishJob(handle.db, running.id, 'cancelled');
    expect(await requestJobCancellation(handle.db, running.id)).toBe('cancelled');
  });

  it('marks jobs with stale heartbeats as interrupted', async () => {
    const payload = await seedJobTargets();
    const job = await enqueueBenchmarkJob(handle.db, payload);
    await acquireNextJob(handle.db, 'r');
    await heartbeatJob(handle.db, job.id);
    expect(await recoverStaleJobs(handle.db, '2000-01-01T00:00:00.000Z')).toEqual([]);
    expect(await recoverStaleJobs(handle.db, '2999-01-01T00:00:00.000Z')).toEqual([job.id]);
    const stats = await getDashboardStats(handle.db);
    expect(stats.artifactCount).toBe(1);
  });
});
