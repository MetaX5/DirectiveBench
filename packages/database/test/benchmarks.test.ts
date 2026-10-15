import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignBenchmarkSuite,
  getSuiteDetail,
  getSuiteVersion,
  importArtifactVersion,
  importSuiteVersion,
  listSuites,
  recordFixtureVersion,
  schema,
} from '../src/index';
import { artifactInput, seedRun, seedTargets, suiteInput } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

afterEach(() => {
  vi.useRealTimers();
});

describe('recordFixtureVersion', () => {
  it('stores a content-addressed fixture once', async () => {
    const { db } = getHandle();
    const input = { id: 'sha-1', sourcePath: 'fixtures/a', fileCount: 2, totalBytes: 10 };
    await recordFixtureVersion(db, input);
    await recordFixtureVersion(db, { ...input, fileCount: 99 });
    const rows = await db.select().from(schema.fixtureVersions);
    expect(rows).toEqual([expect.objectContaining(input)]);
  });
});

describe('importSuiteVersion', () => {
  it('adds a version only for new content and keeps names in sync with the source', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
    const handle = getHandle();
    const first = await importSuiteVersion(handle, suiteInput('h1'));
    expect(first).toMatchObject({ version: 1, createdVersion: true });

    const same = await importSuiteVersion(handle, suiteInput('h1', { name: 'Renamed' }));
    expect(same).toEqual({ ...first, createdVersion: false });

    const second = await importSuiteVersion(
      handle,
      suiteInput('h2', {
        name: 'Renamed again',
        description: 'Now described',
        sourcePath: 'benchmarks/suite.yaml',
        approval: 'bundled-example',
        fixtures: { case1: { fixture: 'sha-1', overlay: 'sha-2' } },
      }),
    );
    expect(second).toMatchObject({ suiteId: first.suiteId, version: 2, createdVersion: true });

    const v1 = await getSuiteVersion(handle.db, first.versionId);
    expect(v1?.version).toMatchObject({
      executionApprovedAt: null,
      executionApprovalSource: null,
      definition: { id: 'suite' },
    });
    const v2 = await getSuiteVersion(handle.db, second.versionId);
    expect(v2?.suite).toMatchObject({ name: 'Renamed again', description: 'Now described' });
    expect(v2?.version).toMatchObject({
      executionApprovedAt: '2026-02-01T00:00:00.000Z',
      executionApprovalSource: 'bundled-example',
      sourcePath: 'benchmarks/suite.yaml',
      fixtures: { case1: { fixture: 'sha-1', overlay: 'sha-2' } },
    });
  });
});

describe('getSuiteVersion', () => {
  it('returns null for an unknown version', async () => {
    expect(await getSuiteVersion(getHandle().db, 'suitev_missing')).toBeNull();
  });
});

describe('listSuites', () => {
  it('returns an empty list for an empty database', async () => {
    expect(await listSuites(getHandle().db)).toEqual([]);
  });

  it('summarises versions, assignments and runs per suite', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const v2 = await importSuiteVersion(handle, suiteInput('h2'));
    const idle = await importSuiteVersion(handle, suiteInput('i1', { slug: 'idle', name: 'Idle' }));
    const other = await importArtifactVersion(handle, artifactInput('o', { slug: 'other' }));
    await assignBenchmarkSuite(handle.db, targets.artifactId, targets.suiteId);
    await assignBenchmarkSuite(handle.db, other.artifactId, targets.suiteId);

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await seedRun(handle, targets);
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    const latestRun = await seedRun(handle, { ...targets, suiteVersionId: v2.versionId });

    const suites = await listSuites(handle.db);
    expect(suites.map((s) => s.suite.name)).toEqual(['Idle', 'Suite']);
    expect(suites[0]).toMatchObject({
      latestVersion: expect.objectContaining({ id: idle.versionId }),
      assignedArtifactCount: 0,
      lastRun: null,
      runCount: 0,
    });
    expect(suites[1]).toMatchObject({
      latestVersion: expect.objectContaining({ id: v2.versionId, version: 2 }),
      assignedArtifactCount: 2,
      lastRun: expect.objectContaining({ id: latestRun }),
      runCount: 2,
    });
  });

  it('lists a suite whose versions are missing', async () => {
    const { db } = getHandle();
    await db.insert(schema.benchmarkSuites).values({
      id: 'suite_bare',
      slug: 'bare',
      name: 'Bare',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await listSuites(db)).toEqual([
      expect.objectContaining({ latestVersion: null, lastRun: null, runCount: 0 }),
    ]);
    expect(await getSuiteDetail(db, 'suite_bare')).toMatchObject({
      versions: [],
      latestVersion: null,
      assignedArtifacts: [],
    });
  });
});

describe('getSuiteDetail', () => {
  it('returns null for an unknown suite', async () => {
    expect(await getSuiteDetail(getHandle().db, 'suite_missing')).toBeNull();
  });

  it('returns versions newest first and assigned artifacts by name', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle, { artifact: { name: 'Zed' } });
    const v2 = await importSuiteVersion(handle, suiteInput('h2'));
    const other = await importArtifactVersion(
      handle,
      artifactInput('o', { slug: 'other', name: 'Ant', type: 'rule' }),
    );
    await assignBenchmarkSuite(handle.db, targets.artifactId, targets.suiteId);
    await assignBenchmarkSuite(handle.db, other.artifactId, targets.suiteId);

    const detail = await getSuiteDetail(handle.db, targets.suiteId);
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail?.latestVersion?.id).toBe(v2.versionId);
    expect(detail?.assignedArtifacts).toEqual([
      { id: other.artifactId, name: 'Ant', slug: 'other', type: 'rule' },
      { id: targets.artifactId, name: 'Zed', slug: 'validate', type: 'skill' },
    ]);
  });
});
