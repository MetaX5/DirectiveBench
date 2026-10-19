import { hashManifest, sha256 } from '@directivebench/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireNextJob,
  applyRepositoryScan,
  assignBenchmarkSuite,
  enqueueRepositoryScanJob,
  JobNoLongerRunningError,
  markRepositoryScanFailed,
  NotFoundError,
  requestJobCancellation,
  type DatabaseHandle,
  type ScannedArtifactInput,
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
  withTransaction,
} from '../src/index';
import { artifactInput, registerLocal, seedRun, seedTargets } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();
/** A scan's abort signal that is never aborted. */
const signal = new AbortController().signal;

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

  it('rejects a path or content that is not well-formed Unicode and writes nothing', async () => {
    const handle = getHandle();
    // '\uD800' and '\uFFFD' encode to the same UTF-8 bytes, so they would share one identity.
    const loneSurrogate = artifactInput('unused', {
      files: [{ path: 'SKILL.md', content: 'a\uD800b' }],
    });
    await expect(importArtifactVersion(handle, loneSurrogate)).rejects.toThrow(
      'File path or content is not well-formed Unicode: "SKILL.md"',
    );
    // The manifest hash encodes paths the same way, so a lone surrogate in a path is rejected too.
    const loneSurrogatePath = artifactInput('unused', {
      files: [{ path: 'ref\uD800.md', content: 'fine' }],
    });
    await expect(importArtifactVersion(handle, loneSurrogatePath)).rejects.toThrow(
      'File path or content is not well-formed Unicode: "ref\\ud800.md"',
    );
    expect(await handle.db.select().from(schema.artifacts).all()).toEqual([]);

    // A well-formed surrogate pair (an emoji) is fine, and sha256/size may be omitted.
    const emoji = await importArtifactVersion(
      handle,
      artifactInput('unused', { files: [{ path: 'SKILL.md', content: 'ok \u{1F600}' }] }),
    );
    expect(emoji).toMatchObject({ version: 1, createdVersion: true });
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
        repository: { provider: 'local-directory', name: 'fixtures', location: '/srv/mirror' },
      }),
    );
    await importArtifactVersion(
      handle,
      artifactInput('v1', {
        repository: { provider: 'local-directory', name: 'upstream', location: '/srv/upstream' },
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

  it('matches slugs only among artifacts of the same provider', async () => {
    const handle = getHandle();
    const bundled = { provider: 'bundled-examples' as const, name: 'Bundled', location: '/a' };
    const first = await importArtifactVersion(handle, artifactInput('v1'));
    const other = await importArtifactVersion(handle, artifactInput('v1', { repository: bundled }));
    // A later install moves the examples: the same provider still finds the artifact by slug.
    const moved = await importArtifactVersion(
      handle,
      artifactInput('v2', { repository: { ...bundled, location: '/b' } }),
    );
    expect(other.artifactId).not.toBe(first.artifactId);
    expect(moved).toMatchObject({ artifactId: other.artifactId, version: 2 });
    const slugs = await handle.db
      .select({ slug: schema.artifacts.slug })
      .from(schema.artifacts)
      .orderBy(schema.artifacts.slug);
    expect(slugs.map((row) => row.slug)).toEqual(['validate', 'validate-2']);
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

function scanned(path: string, content: string, name = 'AGENTS.md'): ScannedArtifactInput {
  return {
    path,
    name,
    type: 'instruction',
    description: null,
    format: 'agents-md',
    primaryFile: 'AGENTS.md',
    files: [{ path: 'AGENTS.md', content }],
    parsedMetadata: { warnings: [] },
  };
}

/** Registers a repository and returns it with a running scan job, as the runner would hold it. */
async function runningScan(handle: DatabaseHandle, location: string) {
  const { repository } = await registerLocal(handle, { location });
  const { job } = await enqueueRepositoryScanJob(handle, { repositoryId: repository.id });
  await acquireNextJob(handle.db, 'runner');
  return { repository, jobId: job.id };
}

async function slugsByPath(handle: DatabaseHandle): Promise<string[][]> {
  const rows = await handle.db
    .select({
      repository: schema.repositories.name,
      path: schema.artifactOccurrences.path,
      slug: schema.artifacts.slug,
    })
    .from(schema.artifactOccurrences)
    .innerJoin(schema.artifacts, eq(schema.artifactOccurrences.artifactId, schema.artifacts.id))
    .innerJoin(
      schema.repositories,
      eq(schema.artifactOccurrences.repositoryId, schema.repositories.id),
    )
    .orderBy(schema.repositories.name, schema.artifactOccurrences.path);
  return rows.map((row) => [row.repository, row.path, row.slug]);
}

describe('applyRepositoryScan', () => {
  it('stores discovered artifacts with recomputed hashes and records a successful scan', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const { repository, jobId } = await runningScan(handle, '/srv/skills');
    const input = scanned('AGENTS.md', '# Rules\n');
    // A caller-supplied hash and size are ignored (SPEC-103 FR-103-04).
    input.files = [{ path: 'AGENTS.md', content: '# Rules\n', sha256: 'f'.repeat(64), size: 1 }];
    const summary = await applyRepositoryScan(handle, {
      repositoryId: repository.id,
      jobId,
      signal,
      artifacts: [input, scanned('packages/api/AGENTS.md', '# API\n', 'packages/api/AGENTS.md')],
    });
    expect(summary).toEqual({ createdArtifacts: 2, createdVersions: 2 });

    const versions = await handle.db.select().from(schema.artifactVersions);
    const root = versions.find((version) => version.sourcePath === 'AGENTS.md');
    const bytes = Buffer.from('# Rules\n');
    expect(root).toMatchObject({
      sourceRepositoryId: repository.id,
      sourceCommitSha: null,
      files: [
        { path: 'AGENTS.md', sha256: sha256(bytes), size: bytes.length, content: '# Rules\n' },
      ],
      contentHash: hashManifest([{ path: 'AGENTS.md', sha256: sha256(bytes) }]),
    });
    expect(await slugsByPath(handle)).toEqual([
      ['repo', 'AGENTS.md', 'agents-md'],
      ['repo', 'packages/api/AGENTS.md', 'packages-api-agents-md'],
    ]);
    const occurrences = await handle.db.select().from(schema.artifactOccurrences);
    expect(occurrences.every((o) => o.commitSha === null && o.status === 'active')).toBe(true);
    const stored = await handle.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repository.id))
      .get();
    expect(stored).toMatchObject({
      lastSyncAt: '2026-04-01T00:00:00.000Z',
      syncStatus: 'ok',
      syncError: null,
      lastCommitSha: null,
    });
  });

  it('keeps the artifact of an occurrence and versions only changed content', async () => {
    const handle = getHandle();
    const first = await runningScan(handle, '/srv/skills');
    const apply = (content: string, jobId: string) =>
      applyRepositoryScan(handle, {
        repositoryId: first.repository.id,
        jobId,
        signal,
        artifacts: [scanned('AGENTS.md', content)],
      });
    expect(await apply('v1', first.jobId)).toEqual({ createdArtifacts: 1, createdVersions: 1 });
    expect(await apply('v1', first.jobId)).toEqual({ createdArtifacts: 0, createdVersions: 0 });
    expect(await apply('v2', first.jobId)).toEqual({ createdArtifacts: 0, createdVersions: 1 });
    const versions = await handle.db
      .select({ version: schema.artifactVersions.version })
      .from(schema.artifactVersions);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    expect(await handle.db.$count(schema.artifacts)).toBe(1);
  });

  it('leaves an occurrence the scan did not deliver exactly as it was (a discovery error)', async () => {
    // A skill with an unreadable directory, or one below an unreadable `.agents/skills`, is not
    // in `artifacts`: no new version, not marked missing, not deleted, not even touched.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const { repository, jobId } = await runningScan(handle, '/srv/skills');
    const apply = (artifacts: ScannedArtifactInput[]) =>
      applyRepositoryScan(handle, { repositoryId: repository.id, jobId, artifacts, signal });
    await apply([scanned('AGENTS.md', 'v1'), scanned('packages/api/AGENTS.md', 'v1', 'api')]);
    const before = await handle.db.select().from(schema.artifactOccurrences);
    const versionsBefore = await handle.db.select().from(schema.artifactVersions);
    const artifactsBefore = await handle.db.select().from(schema.artifacts);

    vi.setSystemTime(new Date('2026-04-02T00:00:00.000Z'));
    expect(await apply([scanned('AGENTS.md', 'v2')])).toEqual({
      createdArtifacts: 0,
      createdVersions: 1,
    });
    const after = await handle.db.select().from(schema.artifactOccurrences);
    const untouched = before.find((o) => o.path === 'packages/api/AGENTS.md');
    expect(after.find((o) => o.path === 'packages/api/AGENTS.md')).toEqual(untouched);
    expect(untouched).toMatchObject({ status: 'active', lastSeenAt: '2026-04-01T00:00:00.000Z' });
    const apiArtifact = artifactsBefore.find((a) => a.id === untouched?.artifactId);
    expect(await handle.db.select().from(schema.artifacts)).toContainEqual(apiArtifact);
    const versionsAfter = await handle.db.select().from(schema.artifactVersions);
    expect(versionsAfter.filter((v) => v.artifactId === untouched?.artifactId)).toEqual(
      versionsBefore.filter((v) => v.artifactId === untouched?.artifactId),
    );
    // The delivered artifact moved on, so the scan itself did run.
    expect(after.find((o) => o.path === 'AGENTS.md')?.lastSeenAt).toBe('2026-04-02T00:00:00.000Z');
  });

  it('never merges same-named artifacts by slug, in either order with bundled examples', async () => {
    const handle = getHandle();
    // Bundled example first, then a repository skill with the same name.
    await importArtifactVersion(
      handle,
      artifactInput('bundled', {
        repository: { provider: 'bundled-examples', name: 'Bundled', location: '/opt/a' },
        slug: 'agents-md',
        name: 'AGENTS.md',
        type: 'instruction',
      }),
    );
    const a = await runningScan(handle, '/srv/a');
    await applyRepositoryScan(handle, {
      repositoryId: a.repository.id,
      jobId: a.jobId,
      signal,
      artifacts: [scanned('AGENTS.md', 'same'), scanned('docs/x/AGENTS.md', 'same')],
    });
    const b = await runningScan(handle, '/srv/b');
    await applyRepositoryScan(handle, {
      repositoryId: b.repository.id,
      jobId: b.jobId,
      signal,
      artifacts: [scanned('AGENTS.md', 'same')],
    });
    // A later bundled import (moved install) still finds its own artifact, not a scanned one.
    const moved = await importArtifactVersion(
      handle,
      artifactInput('bundled', {
        repository: { provider: 'bundled-examples', name: 'Bundled', location: '/opt/b' },
        slug: 'agents-md',
        name: 'AGENTS.md',
        type: 'instruction',
      }),
    );
    expect(moved.createdVersion).toBe(false);

    expect(await slugsByPath(handle)).toEqual([
      ['Bundled', 'skills/validate', 'agents-md'],
      ['Bundled', 'skills/validate', 'agents-md'],
      ['repo', 'AGENTS.md', 'agents-md-2'],
      ['repo', 'AGENTS.md', 'agents-md-4'],
      ['repo', 'docs/x/AGENTS.md', 'agents-md-3'],
    ]);
  });

  it('assigns a scanned skill a free slug when a bundled skill already uses it, and vice versa', async () => {
    const handle = getHandle();
    const scan = await runningScan(handle, '/srv/a');
    await applyRepositoryScan(handle, {
      repositoryId: scan.repository.id,
      jobId: scan.jobId,
      signal,
      artifacts: [{ ...scanned('skills/validate', 'mine', 'validate'), type: 'skill' }],
    });
    // Scan first, bundled example second: the bundled import must not attach to the scanned skill.
    const bundled = await importArtifactVersion(
      handle,
      artifactInput('bundled', {
        repository: { provider: 'bundled-examples', name: 'Bundled', location: '/opt/a' },
      }),
    );
    expect(bundled.version).toBe(1);
    expect(await slugsByPath(handle)).toEqual([
      ['Bundled', 'skills/validate', 'validate-2'],
      ['repo', 'skills/validate', 'validate'],
    ]);
  });

  it('writes nothing when the job was cancelled or finished meanwhile, or the repository is gone', async () => {
    const handle = getHandle();
    const { repository, jobId } = await runningScan(handle, '/srv/skills');
    const application = {
      repositoryId: repository.id,
      jobId,
      artifacts: [scanned('AGENTS.md', 'x')],
      signal,
    };
    await requestJobCancellation(handle.db, jobId);
    await expect(applyRepositoryScan(handle, application)).rejects.toThrow(JobNoLongerRunningError);
    await expect(
      applyRepositoryScan(handle, { ...application, jobId: 'job_missing' }),
    ).rejects.toThrow(JobNoLongerRunningError);

    const other = await runningScan(handle, '/srv/other');
    handle.sqlite.exec(`delete from repositories where id = '${other.repository.id}'`);
    await expect(
      applyRepositoryScan(handle, {
        repositoryId: other.repository.id,
        jobId: other.jobId,
        signal,
        artifacts: [scanned('AGENTS.md', 'x')],
      }),
    ).rejects.toThrow(NotFoundError);
    expect(await handle.db.$count(schema.artifacts)).toBe(0);
  });

  it('writes nothing when its signal is aborted while it waits behind another transaction', async () => {
    // Runner shutdown aborts the signal but records nothing in the job row, so the transaction
    // must check the signal itself: the scan checked it before queueing, the abort came after.
    const handle = getHandle();
    const { repository, jobId } = await runningScan(handle, '/srv/skills');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withTransaction(handle, () => gate);
    const controller = new AbortController();
    const applied = applyRepositoryScan(handle, {
      repositoryId: repository.id,
      jobId,
      artifacts: [scanned('AGENTS.md', 'x')],
      signal: controller.signal,
    });
    controller.abort('shutdown');
    release();
    await holding;
    await expect(applied).rejects.toThrow(
      new JobNoLongerRunningError(`Job ${jobId} was aborted before its results were stored`),
    );
    expect(await handle.db.$count(schema.artifacts)).toBe(0);
    const stored = await handle.db
      .select({ syncStatus: schema.repositories.syncStatus })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repository.id))
      .get();
    expect(stored?.syncStatus).not.toBe('ok');
  });

  it('rejects content that is not well-formed Unicode before writing anything', async () => {
    const handle = getHandle();
    const { repository, jobId } = await runningScan(handle, '/srv/skills');
    await expect(
      applyRepositoryScan(handle, {
        repositoryId: repository.id,
        jobId,
        signal,
        artifacts: [scanned('AGENTS.md', 'bad \ud800')],
      }),
    ).rejects.toThrow(/not well-formed Unicode/);
    expect(await handle.db.$count(schema.artifacts)).toBe(0);
  });
});

describe('markRepositoryScanFailed', () => {
  it('records the error without touching artifacts or the last successful scan time', async () => {
    const handle = getHandle();
    const { repository } = await registerLocal(handle, { location: '/srv/skills' });
    await markRepositoryScanFailed(handle.db, repository.id, 'No directory exists at this path.');
    const stored = await handle.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repository.id))
      .get();
    expect(stored).toMatchObject({
      syncStatus: 'error',
      syncError: 'No directory exists at this path.',
      lastSyncAt: null,
    });
  });
});
