import { hashManifest, sha256 } from '@directivebench/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignBenchmarkSuite,
  assignCategoriesBySlug,
  finishBenchmarkRun,
  getArtifactBundle,
  getArtifactDetail,
  getLatestArtifactVersionId,
  importArtifactVersion,
  listArtifacts,
  schema,
  seedPredefinedCategories,
  upsertRepository,
} from '../src/index';
import { artifactInput, seedRun, seedTargets } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

afterEach(() => {
  vi.useRealTimers();
});

describe('upsertRepository', () => {
  it('returns the existing id for the same provider and location', async () => {
    const { db } = getHandle();
    const ref = { provider: 'local-git' as const, name: 'repo', location: '/srv/repo' };
    const id = await upsertRepository(db, ref);
    expect(await upsertRepository(db, { ...ref, name: 'renamed' })).toBe(id);
    expect(await upsertRepository(db, { ...ref, provider: 'local-directory' })).not.toBe(id);
  });
});

describe('importArtifactVersion', () => {
  it('creates immutable versions only for new content and preserves user metadata', async () => {
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const first = await importArtifactVersion(handle, artifactInput('v1'));
    expect(first).toMatchObject({ version: 1, createdVersion: true });
    await assignCategoriesBySlug(handle.db, first.artifactId, ['security', 'nope']);
    await handle.db
      .update(schema.artifacts)
      .set({ notes: 'keep me', tags: ['mine'] })
      .where(eq(schema.artifacts.id, first.artifactId));

    const same = await importArtifactVersion(handle, artifactInput('v1'));
    expect(same).toEqual({ ...first, createdVersion: false });

    const second = await importArtifactVersion(
      handle,
      artifactInput('v2', { name: 'Validate v2', description: null }),
    );
    expect(second).toMatchObject({
      artifactId: first.artifactId,
      version: 2,
      createdVersion: true,
    });

    const detail = await getArtifactDetail(handle.db, first.artifactId);
    expect(detail?.artifact).toMatchObject({
      name: 'Validate v2',
      description: null,
      notes: 'keep me',
      tags: ['mine'],
    });
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(detail?.categories.map((c) => c.slug)).toEqual(['security']);
    expect(detail?.occurrences).toHaveLength(1);
    expect(detail?.occurrences[0]?.occurrence.latestVersionId).toBe(second.versionId);
    expect(detail?.evaluations).toEqual([]);
  });

  it('recomputes the content hash from the files and ignores a caller-supplied one', async () => {
    const handle = getHandle();
    const files = [
      { path: 'scripts/check.sh', sha256: 'b'.repeat(64), size: 1, content: 'b' },
      { path: 'SKILL.md', sha256: 'a'.repeat(64), size: 1, content: 'a' },
    ];
    const expected = hashManifest([
      { path: 'SKILL.md', sha256: sha256('a') },
      { path: 'scripts/check.sh', sha256: sha256('b') },
    ]);
    // An untyped caller (or a future untrusted source) smuggling in a forged hash.
    const forged = { ...artifactInput('v1', { files }), contentHash: 'forged' };
    const first = await importArtifactVersion(handle, forged);

    const stored = await handle.db
      .select({ contentHash: schema.artifactVersions.contentHash })
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.id, first.versionId))
      .get();
    expect(stored?.contentHash).toBe(expected);

    // Deduplication uses the recomputed hash: same files, different forged hash, same version.
    const reordered = {
      ...artifactInput('v1', { files: [...files].reverse() }),
      contentHash: 'another-forgery',
    };
    const again = await importArtifactVersion(handle, reordered);
    expect(again).toEqual({ ...first, createdVersion: false });
  });

  it('recomputes each file sha256 and size from its content and ignores the caller values', async () => {
    const handle = getHandle();
    const content = 'Zażółć gęślą jaźń\n';
    const decoy = 'Decoy content\n';
    // A caller pairing `content` with the hash of another file to borrow that file's identity.
    const forged = artifactInput('unused', {
      files: [{ path: 'SKILL.md', sha256: sha256(decoy), size: 1, content }],
    });
    const first = await importArtifactVersion(handle, forged);

    const stored = await handle.db
      .select({
        contentHash: schema.artifactVersions.contentHash,
        files: schema.artifactVersions.files,
      })
      .from(schema.artifactVersions)
      .where(eq(schema.artifactVersions.id, first.versionId))
      .get();
    const recomputed = sha256(Buffer.from(content, 'utf8'));
    expect(recomputed).not.toBe(sha256(decoy));
    expect(stored?.files).toEqual([
      { path: 'SKILL.md', sha256: recomputed, size: Buffer.byteLength(content), content },
    ]);
    expect(stored?.contentHash).toBe(hashManifest([{ path: 'SKILL.md', sha256: recomputed }]));

    // The decoy's identity was not taken: importing the decoy creates its own version, and an
    // honest import of `content` reuses the first one.
    const decoyImport = await importArtifactVersion(
      handle,
      artifactInput('unused', {
        files: [{ path: 'SKILL.md', sha256: sha256(decoy), size: decoy.length, content: decoy }],
      }),
    );
    expect(decoyImport).toMatchObject({ version: 2, createdVersion: true });
    const honest = await importArtifactVersion(
      handle,
      artifactInput('unused', {
        files: [{ path: 'SKILL.md', sha256: recomputed, size: 1, content }],
      }),
    );
    expect(honest).toEqual({ ...first, createdVersion: false });
  });

  it('records the commit on the version and the occurrence', async () => {
    const handle = getHandle();
    const first = await importArtifactVersion(handle, artifactInput('v1', { commitSha: 'abc' }));
    const again = await importArtifactVersion(handle, artifactInput('v1'));
    expect(again.versionId).toBe(first.versionId);

    const detail = await getArtifactDetail(handle.db, first.artifactId);
    expect(detail?.versions[0]?.sourceCommitSha).toBe('abc');
    expect(detail?.occurrences[0]?.occurrence.commitSha).toBeNull();
  });

  it('tracks an artifact found in several repositories and reactivates removed occurrences', async () => {
    const handle = getHandle();
    const first = await importArtifactVersion(handle, artifactInput('v1'));
    await importArtifactVersion(
      handle,
      artifactInput('v1', {
        repository: { provider: 'local-git', name: 'fixtures', location: '/srv/mirror' },
      }),
    );
    await importArtifactVersion(
      handle,
      artifactInput('v1', {
        repository: { provider: 'github', name: 'upstream', location: 'https://x/y.git' },
      }),
    );

    const detail = await getArtifactDetail(handle.db, first.artifactId);
    expect(detail?.versions).toHaveLength(1);
    expect(detail?.occurrences).toHaveLength(3);
    expect((await listArtifacts(handle.db))[0]?.sources.sort()).toEqual(['fixtures', 'upstream']);

    await handle.db
      .update(schema.artifactOccurrences)
      .set({ status: 'removed' })
      .where(eq(schema.artifactOccurrences.artifactId, first.artifactId));
    expect((await listArtifacts(handle.db))[0]?.sources).toEqual([]);

    await importArtifactVersion(handle, artifactInput('v1'));
    expect((await listArtifacts(handle.db))[0]?.sources).toEqual(['fixtures']);
  });
});

describe('assignCategoriesBySlug', () => {
  it('assigns known active categories once and reports unknown slugs', async () => {
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const { artifactId } = await importArtifactVersion(handle, artifactInput('v1'));
    await handle.db
      .update(schema.categories)
      .set({ archivedAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(schema.categories.slug, 'testing'));

    expect(await assignCategoriesBySlug(handle.db, artifactId, [])).toEqual({
      assigned: [],
      unknown: [],
    });
    const result = await assignCategoriesBySlug(handle.db, artifactId, [
      'security',
      'testing',
      'made-up',
    ]);
    expect(result).toEqual({ assigned: ['security'], unknown: ['testing', 'made-up'] });
    expect(await assignCategoriesBySlug(handle.db, artifactId, ['security'])).toEqual({
      assigned: ['security'],
      unknown: [],
    });
    expect((await listArtifacts(handle.db))[0]?.categories).toEqual([
      { slug: 'security', name: 'Security' },
    ]);
  });
});

describe('assignBenchmarkSuite', () => {
  it('links a suite to an artifact idempotently', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    await assignBenchmarkSuite(handle.db, targets.artifactId, targets.suiteId);
    await assignBenchmarkSuite(handle.db, targets.artifactId, targets.suiteId);

    expect((await listArtifacts(handle.db))[0]?.benchmarkCount).toBe(1);
    const detail = await getArtifactDetail(handle.db, targets.artifactId);
    expect(detail?.suites).toEqual([{ id: targets.suiteId, slug: 'suite', name: 'Suite' }]);
  });
});

describe('listArtifacts', () => {
  it('returns an empty list for an empty database', async () => {
    expect(await listArtifacts(getHandle().db)).toEqual([]);
  });

  it('orders by name and handles artifacts without versions', async () => {
    const handle = getHandle();
    await importArtifactVersion(handle, artifactInput('v1', { slug: 'zeta', name: 'Zeta' }));
    await handle.db.insert(schema.artifacts).values({
      id: 'art_empty',
      slug: 'alpha',
      name: 'Alpha',
      type: 'rule',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const list = await listArtifacts(handle.db);
    expect(list.map((a) => a.name)).toEqual(['Alpha', 'Zeta']);
    expect(list[0]).toEqual({
      id: 'art_empty',
      slug: 'alpha',
      name: 'Alpha',
      type: 'rule',
      description: null,
      format: null,
      latestVersion: null,
      categories: [],
      sources: [],
      benchmarkCount: 0,
      latestEvaluation: null,
    });
    expect(list[1]).toMatchObject({ format: 'skill-md', latestVersion: 1 });

    const detail = await getArtifactDetail(handle.db, 'art_empty');
    expect(detail).toMatchObject({ versions: [], occurrences: [], evaluations: [] });
    expect(await getLatestArtifactVersionId(handle.db, 'art_empty')).toBeNull();
  });

  it('reports the most recent run across all versions as the latest evaluation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const v2 = await importArtifactVersion(handle, artifactInput('v2'));

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const older = await seedRun(handle, targets);
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    const newer = await seedRun(handle, {
      artifactVersionId: v2.versionId,
      suiteVersionId: targets.suiteVersionId,
    });
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
    await finishBenchmarkRun(handle.db, newer, {
      status: 'completed',
      verdict: 'improved',
      summary: {
        candidateOutcome: 'pass',
        baseline: { meanScore: 0.25 },
        candidate: { meanScore: 0.75 },
        delta: 0.5,
      },
      comparabilityKey: 'k',
      warnings: [],
      error: null,
    });

    const [item] = await listArtifacts(handle.db);
    expect(item?.latestEvaluation).toEqual({
      runId: newer,
      verdict: 'improved',
      status: 'completed',
      delta: 0.5,
      candidateOutcome: 'pass',
      candidateScore: 0.75,
      baselineScore: 0.25,
      agentAdapterId: 'mock',
      finishedAt: '2026-01-03T00:00:00.000Z',
      startedAt: '2026-01-02T00:00:00.000Z',
    });

    const detail = await getArtifactDetail(handle.db, targets.artifactId);
    expect(detail?.evaluations).toEqual([
      expect.objectContaining({ runId: newer, artifactVersion: 2, delta: 0.5 }),
      {
        runId: older,
        verdict: null,
        status: 'running',
        delta: null,
        candidateOutcome: null,
        candidateScore: null,
        baselineScore: null,
        agentAdapterId: 'mock',
        finishedAt: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        artifactVersion: 1,
      },
    ]);
  });

  it('treats a summary without scores as missing values', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    const run = await seedRun(handle, targets);
    await finishBenchmarkRun(handle.db, run, {
      status: 'error',
      verdict: null,
      summary: { baseline: {}, candidate: {} },
      comparabilityKey: null,
      warnings: ['w'],
      error: 'failed',
    });
    const [item] = await listArtifacts(handle.db);
    expect(item?.latestEvaluation).toMatchObject({
      status: 'error',
      verdict: null,
      delta: null,
      candidateOutcome: null,
      candidateScore: null,
      baselineScore: null,
    });
  });
});

describe('getArtifactDetail', () => {
  it('returns null for an unknown artifact', async () => {
    expect(await getArtifactDetail(getHandle().db, 'art_missing')).toBeNull();
  });
});

describe('getArtifactBundle', () => {
  it('loads one exact version in the adapter shape', async () => {
    const handle = getHandle();
    const v1 = await importArtifactVersion(handle, artifactInput('v1'));
    await importArtifactVersion(handle, artifactInput('v2'));

    expect(await getArtifactBundle(handle.db, v1.versionId)).toEqual({
      artifactId: v1.artifactId,
      versionId: v1.versionId,
      slug: 'validate',
      name: 'validate',
      type: 'skill',
      format: 'skill-md',
      contentHash: hashManifest([{ path: 'SKILL.md', sha256: sha256('v1') }]),
      files: [{ path: 'SKILL.md', sha256: sha256('v1'), size: 2, content: 'v1' }],
    });
    expect(await getArtifactBundle(handle.db, 'artv_missing')).toBeNull();
  });
});

describe('getLatestArtifactVersionId', () => {
  it('returns the highest version', async () => {
    const handle = getHandle();
    const v1 = await importArtifactVersion(handle, artifactInput('v1'));
    expect(await getLatestArtifactVersionId(handle.db, v1.artifactId)).toBe(v1.versionId);
    const v2 = await importArtifactVersion(handle, artifactInput('v2'));
    expect(await getLatestArtifactVersionId(handle.db, v1.artifactId)).toBe(v2.versionId);
  });
});
