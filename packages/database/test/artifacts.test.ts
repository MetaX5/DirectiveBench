import { hashManifest, sha256 } from '@directivebench/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireNextJob,
  applyRepositoryScan,
  ArtifactStoreError,
  addArtifactTag,
  assignArtifactSuite,
  assignBenchmarkSuite,
  MAX_ARTIFACT_TAGS,
  removeArtifactTag,
  setArtifactNotes,
  unassignArtifactSuite,
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
  importSuiteVersion,
  hasArtifacts,
  listArtifacts,
  schema,
  seedPredefinedCategories,
  upsertRepository,
  withTransaction,
} from '../src/index';
import { artifactInput, registerLocal, seedRun, seedTargets, suiteInput } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();
/** A scan's abort signal that is never aborted. */
const signal = new AbortController().signal;
/** Statements one new artifact costs besides its slug: identity, insert, version and occurrence. */
const STATEMENTS_PER_NEW_ARTIFACT = 8;
/** Storing 3,000 artifacts takes ~1 s locally; a loaded CI runner can be several times slower. */
const MANY_ARTIFACTS_TIMEOUT_MS = 30_000;

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
    const [listed] = await listArtifacts(handle.db);
    // Two repositories are both named "fixtures": they are listed separately, by name.
    expect(listed?.repositories.map((r) => r.name)).toEqual(['fixtures', 'fixtures', 'upstream']);
    expect(listed?.occurrenceCount).toBe(3);

    await handle.db
      .update(schema.artifactOccurrences)
      .set({ status: 'removed' })
      .where(eq(schema.artifactOccurrences.artifactId, first.artifactId));
    expect((await listArtifacts(handle.db))[0]).toMatchObject({
      repositories: [],
      occurrenceCount: 0,
    });

    await importArtifactVersion(handle, artifactInput('v1'));
    expect((await listArtifacts(handle.db))[0]).toMatchObject({
      repositories: [{ name: 'fixtures' }],
      occurrenceCount: 1,
    });
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

  it('allocates suffixes for slugs that contain LIKE wildcards or a backslash', async () => {
    const handle = getHandle();
    const local = { provider: 'local-directory' as const, name: 'local', location: '/l' };
    const bundled = { provider: 'bundled-examples' as const, name: 'Bundled', location: '/b' };
    const importSlug = (repository: typeof local | typeof bundled, slug: string, name = slug) =>
      importArtifactVersion(handle, artifactInput(name, { repository, slug, name, path: name }));
    for (const slug of ['a_b', 'axb-2', 'a%b', 'a%b-2', 'azb-3', 'a\\b', 'a', 'a-b', 'a.b']) {
      await importSlug(local, slug);
    }
    // Another provider never matches by slug, and the names differ, so each is a new artifact.
    const created = [];
    for (const [slug, name] of [
      ['a_b', 'one'],
      ['a_b', 'two'],
      ['a%b', 'three'],
      ['a\\b', 'four'],
      ['axb', 'five'],
      ['a', 'six'],
      ['a', 'seven'],
    ] as const) {
      created.push((await importSlug(bundled, slug, name)).artifactId);
    }
    const rows = await handle.db
      .select({ id: schema.artifacts.id, slug: schema.artifacts.slug })
      .from(schema.artifacts);
    const slugOf = new Map(rows.map((row) => [row.id, row.slug]));
    expect(created.map((id) => slugOf.get(id))).toEqual([
      'a_b-2',
      'a_b-3',
      'a%b-3',
      'a\\b-2',
      'axb',
      'a-2',
      'a-3',
    ]);
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

describe('user metadata editing (issue #64)', () => {
  it('adds a tag once, keeps the order and stops at the limit', async () => {
    const handle = getHandle();
    const { artifactId } = await importArtifactVersion(handle, artifactInput('v1'));
    expect(await addArtifactTag(handle, artifactId, 'security')).toBe('added');
    expect(await addArtifactTag(handle, artifactId, 'review')).toBe('added');
    expect(await addArtifactTag(handle, artifactId, 'security')).toBe('exists');
    expect((await getArtifactDetail(handle.db, artifactId))?.artifact.tags).toEqual([
      'security',
      'review',
    ]);
    for (let i = 2; i < MAX_ARTIFACT_TAGS; i++) {
      expect(await addArtifactTag(handle, artifactId, `tag-${i}`)).toBe('added');
    }
    expect(await addArtifactTag(handle, artifactId, 'one-too-many')).toBe('limit');
    // An existing tag is still reported as present at the limit.
    expect(await addArtifactTag(handle, artifactId, 'review')).toBe('exists');
    expect((await getArtifactDetail(handle.db, artifactId))?.artifact.tags).toHaveLength(
      MAX_ARTIFACT_TAGS,
    );
  });

  it('keeps both tags of two concurrent adds', async () => {
    const handle = getHandle();
    const { artifactId } = await importArtifactVersion(handle, artifactInput('v1'));
    await Promise.all([
      addArtifactTag(handle, artifactId, 'a'),
      addArtifactTag(handle, artifactId, 'b'),
    ]);
    const tags = (await getArtifactDetail(handle.db, artifactId))?.artifact.tags;
    expect([...(tags ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('removes a tag and reports a tag that was not there', async () => {
    const handle = getHandle();
    const { artifactId } = await importArtifactVersion(handle, artifactInput('v1'));
    await addArtifactTag(handle, artifactId, 'security');
    await addArtifactTag(handle, artifactId, 'review');
    expect(await removeArtifactTag(handle, artifactId, 'security')).toBe(true);
    expect(await removeArtifactTag(handle, artifactId, 'security')).toBe(false);
    expect((await getArtifactDetail(handle.db, artifactId))?.artifact.tags).toEqual(['review']);
  });

  it('refuses tags and notes of an unknown artifact', async () => {
    const handle = getHandle();
    await expect(addArtifactTag(handle, 'art_missing', 'x')).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeArtifactTag(handle, 'art_missing', 'x')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(setArtifactNotes(handle.db, 'art_missing', 'x')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('sets and clears the notes', async () => {
    const handle = getHandle();
    const { artifactId } = await importArtifactVersion(handle, artifactInput('v1'));
    await setArtifactNotes(handle.db, artifactId, 'line one\nline two');
    expect((await getArtifactDetail(handle.db, artifactId))?.artifact.notes).toBe(
      'line one\nline two',
    );
    await setArtifactNotes(handle.db, artifactId, null);
    expect((await getArtifactDetail(handle.db, artifactId))?.artifact.notes).toBeNull();
  });

  it('assigns and unassigns a suite and names a missing artifact or suite', async () => {
    const handle = getHandle();
    const { artifactId, suiteId } = await seedTargets(handle);
    expect(await assignArtifactSuite(handle, artifactId, suiteId)).toEqual({
      status: 'assigned',
      suiteName: 'Suite',
    });
    expect(await assignArtifactSuite(handle, artifactId, suiteId)).toEqual({
      status: 'already-assigned',
      suiteName: 'Suite',
    });
    expect(await assignArtifactSuite(handle, 'art_missing', suiteId)).toEqual({
      status: 'missing-artifact',
    });
    expect(await assignArtifactSuite(handle, artifactId, 'suite_missing')).toEqual({
      status: 'missing-suite',
    });
    expect((await getArtifactDetail(handle.db, artifactId))?.suites).toHaveLength(1);

    expect(await unassignArtifactSuite(handle, artifactId, suiteId)).toEqual({
      status: 'unassigned',
      suiteName: 'Suite',
    });
    expect(await unassignArtifactSuite(handle, artifactId, suiteId)).toEqual({
      status: 'not-assigned',
      suiteName: 'Suite',
    });
    expect(await unassignArtifactSuite(handle, artifactId, 'suite_missing')).toEqual({
      status: 'missing-suite',
    });
    expect(await unassignArtifactSuite(handle, 'art_missing', suiteId)).toEqual({
      status: 'missing-artifact',
    });
    expect((await getArtifactDetail(handle.db, artifactId))?.suites).toEqual([]);
  });

  it('keeps the runs of an unassigned suite', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    await assignArtifactSuite(handle, targets.artifactId, targets.suiteId);
    await seedRun(handle, targets);
    await unassignArtifactSuite(handle, targets.artifactId, targets.suiteId);
    expect(await handle.db.$count(schema.benchmarkRuns)).toBe(1);
  });
});

describe('listArtifacts', () => {
  it('returns an empty list for an empty database', async () => {
    expect(await listArtifacts(getHandle().db)).toEqual([]);
    expect(await hasArtifacts(getHandle().db)).toBe(false);
    await importArtifactVersion(getHandle(), artifactInput('v1'));
    expect(await hasArtifacts(getHandle().db)).toBe(true);
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
      repositories: [],
      occurrenceCount: 0,
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

describe('listArtifacts filters', () => {
  async function seedTwoRepositories(handle: DatabaseHandle) {
    await seedPredefinedCategories(handle.db);
    const team = { provider: 'local-directory', name: 'team', location: '/srv/team' } as const;
    const client = { provider: 'local-git', name: 'client', location: '/srv/client' } as const;
    const review = await importArtifactVersion(
      handle,
      artifactInput('review', {
        repository: team,
        path: '.agents/skills/review',
        slug: 'review',
        name: 'Review',
        description: 'Reviews ZAŻÓŁĆ pull requests',
      }),
    );
    // The same artifact twice in one repository: one repository, two occurrences.
    await importArtifactVersion(
      handle,
      artifactInput('review', {
        repository: team,
        path: '.claude/skills/review',
        slug: 'review',
        name: 'Review',
        description: 'Reviews ZAŻÓŁĆ pull requests',
      }),
    );
    const rules = await importArtifactVersion(
      handle,
      artifactInput('rules', {
        repository: client,
        path: 'AGENTS.md',
        slug: 'agents',
        name: 'Agents',
        type: 'instruction',
        description: null,
        format: 'agents-md',
        primaryFile: 'AGENTS.md',
      }),
    );
    await assignCategoriesBySlug(handle.db, review.artifactId, ['security']);
    const ids = Object.fromEntries(
      (await handle.db.select().from(schema.repositories)).map((r) => [r.name, r.id]),
    );
    return { review: review.artifactId, rules: rules.artifactId, ids };
  }

  it('lists repositories and occurrence counts of artifacts from several repositories', async () => {
    const handle = getHandle();
    const { ids } = await seedTwoRepositories(handle);
    const list = await listArtifacts(handle.db);
    expect(list.map((a) => [a.name, a.type, a.repositories, a.occurrenceCount])).toEqual([
      ['Agents', 'instruction', [{ id: ids.client, name: 'client' }], 1],
      ['Review', 'skill', [{ id: ids.team, name: 'team' }], 2],
    ]);
  });

  it('narrows by type, category, repository and text, combined with AND', async () => {
    const handle = getHandle();
    const { ids } = await seedTwoRepositories(handle);
    const names = async (filter: Parameters<typeof listArtifacts>[1]) =>
      (await listArtifacts(handle.db, filter)).map((a) => a.name);

    expect(await names({})).toEqual(['Agents', 'Review']);
    expect(await names({ type: 'instruction' })).toEqual(['Agents']);
    expect(await names({ type: 'rule' })).toEqual([]);
    expect(await names({ category: 'security' })).toEqual(['Review']);
    expect(await names({ category: 'python' })).toEqual([]);
    expect(await names({ repository: ids.team })).toEqual(['Review']);
    expect(await names({ repository: ids.client })).toEqual(['Agents']);
    expect(await names({ repository: 'repo_unknown' })).toEqual([]);
    // Case-insensitive beyond ASCII, over name and description; blank text matches everything.
    expect(await names({ q: '  zażółć ' })).toEqual(['Review']);
    expect(await names({ q: 'AGE' })).toEqual(['Agents']);
    expect(await names({ q: '   ' })).toEqual(['Agents', 'Review']);
    expect(await names({ q: 'review', type: 'skill', repository: ids.client })).toEqual([]);
    expect(await names({ type: 'skill', category: 'security', repository: ids.team })).toEqual([
      'Review',
    ]);
  });

  it('matches a repository only through its active occurrences', async () => {
    const handle = getHandle();
    const { review, ids } = await seedTwoRepositories(handle);
    await handle.db
      .update(schema.artifactOccurrences)
      .set({ status: 'removed' })
      .where(eq(schema.artifactOccurrences.artifactId, review));
    expect(await listArtifacts(handle.db, { repository: ids.team })).toEqual([]);
    expect((await listArtifacts(handle.db, { q: 'review' }))[0]).toMatchObject({
      repositories: [],
      occurrenceCount: 0,
    });
  });
});

describe('getArtifactDetail', () => {
  it('orders occurrences by repository name and path', async () => {
    const handle = getHandle();
    const team = { provider: 'local-directory', name: 'team', location: '/srv/team' } as const;
    const first = await importArtifactVersion(
      handle,
      artifactInput('v1', { repository: team, path: 'z/skill' }),
    );
    await importArtifactVersion(handle, artifactInput('v1', { repository: team, path: 'a/skill' }));
    await importArtifactVersion(handle, artifactInput('v1'));
    const detail = await getArtifactDetail(handle.db, first.artifactId);
    expect(detail?.occurrences.map((o) => `${o.repository.name}:${o.occurrence.path}`)).toEqual([
      'fixtures:skills/validate',
      'team:a/skill',
      'team:z/skill',
    ]);
  });

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
      commitSha: null,
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
        commitSha: null,
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

  it('keeps tags, notes and suite assignments edited in the UI across a rescan (issue #64)', async () => {
    const handle = getHandle();
    const first = await runningScan(handle, '/srv/skills');
    const apply = (content: string) =>
      applyRepositoryScan(handle, {
        commitSha: null,
        repositoryId: first.repository.id,
        jobId: first.jobId,
        signal,
        artifacts: [scanned('AGENTS.md', content)],
      });
    await apply('v1');
    const [artifact] = await handle.db.select().from(schema.artifacts);
    const artifactId = artifact?.id ?? '';
    const { suiteId } = await importSuiteVersion(handle, suiteInput('h'));
    await addArtifactTag(handle, artifactId, 'security');
    await setArtifactNotes(handle.db, artifactId, 'Compare with v1.\nKeep it short.');
    await assignArtifactSuite(handle, artifactId, suiteId);

    await apply('v1');
    expect(await apply('v2')).toEqual({ createdArtifacts: 0, createdVersions: 1 });

    const detail = await getArtifactDetail(handle.db, artifactId);
    expect(detail?.artifact).toMatchObject({
      tags: ['security'],
      notes: 'Compare with v1.\nKeep it short.',
    });
    expect(detail?.suites.map((s) => s.id)).toEqual([suiteId]);
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('leaves an occurrence the scan did not deliver exactly as it was (a discovery error)', async () => {
    // A skill with an unreadable directory, or one below an unreadable `.agents/skills`, is not
    // in `artifacts`: no new version, not marked missing, not deleted, not even touched.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const handle = getHandle();
    const { repository, jobId } = await runningScan(handle, '/srv/skills');
    const apply = (artifacts: ScannedArtifactInput[]) =>
      applyRepositoryScan(handle, {
        repositoryId: repository.id,
        jobId,
        artifacts,
        signal,
        commitSha: null,
      });
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
      commitSha: null,
      repositoryId: a.repository.id,
      jobId: a.jobId,
      signal,
      artifacts: [scanned('AGENTS.md', 'same'), scanned('docs/x/AGENTS.md', 'same')],
    });
    const b = await runningScan(handle, '/srv/b');
    await applyRepositoryScan(handle, {
      commitSha: null,
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
      commitSha: null,
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

  // Regression (final Codex review of PR #44): every new artifact probed `base`, `base-2`, … with
  // one query per candidate, so N same-named artifacts cost about N²/2 queries while the scan held
  // `BEGIN IMMEDIATE`. Discovery names a nested AGENTS.md by its path, but a monorepo whose
  // packages each carry a skill with the same frontmatter `name` gives them all one name.
  it(
    'allocates sequential slugs to thousands of same-named artifacts with one slug query',
    async () => {
      const handle = getHandle();
      const { repository, jobId } = await runningScan(handle, '/srv/monorepo');
      const count = 3000;
      const paths = Array.from({ length: count }, (_, i) => `packages/p${i}/.agents/skills/review`);
      const prepare = vi.spyOn(handle.sqlite, 'prepare');
      const summary = await applyRepositoryScan(handle, {
        commitSha: null,
        repositoryId: repository.id,
        jobId,
        signal,
        artifacts: paths.map((path) => ({ ...scanned(path, path, 'review'), type: 'skill' })),
      });
      const statements = prepare.mock.calls.map(([query]) => query);
      prepare.mockRestore();
      expect(summary).toEqual({ createdArtifacts: count, createdVersions: count });
      const slugs = new Map((await slugsByPath(handle)).map(([, path, slug]) => [path, slug]));
      expect(paths.map((path) => slugs.get(path))).toEqual(
        paths.map((_, i) => (i === 0 ? 'review' : `review-${i + 1}`)),
      );
      // One read of the occupied slugs for the one base; the old loop issued about 4.5 million.
      expect(statements.filter((query) => query.includes('"artifacts"."slug"'))).toHaveLength(1);
      expect(statements.length).toBeLessThan(count * STATEMENTS_PER_NEW_ARTIFACT);
    },
    MANY_ARTIFACTS_TIMEOUT_MS,
  );

  it('skips slugs taken by earlier scans, gaps included, and slugs other bases took in this scan', async () => {
    const handle = getHandle();
    const first = await runningScan(handle, '/srv/a');
    await applyRepositoryScan(handle, {
      commitSha: null,
      repositoryId: first.repository.id,
      jobId: first.jobId,
      signal,
      artifacts: [
        scanned('AGENTS.md', 'x'),
        scanned('a/AGENTS.md', 'x'),
        scanned('b/AGENTS.md', 'x', 'agents md 4'),
      ],
    });
    const second = await runningScan(handle, '/srv/b');
    await applyRepositoryScan(handle, {
      commitSha: null,
      repositoryId: second.repository.id,
      jobId: second.jobId,
      signal,
      artifacts: [
        scanned('1/AGENTS.md', 'x'),
        // Base `agents-md-6`, read after `agents-md` was: the next `agents-md`s must skip it.
        scanned('2/AGENTS.md', 'x', 'agents-md-6'),
        scanned('3/AGENTS.md', 'x'),
        scanned('4/AGENTS.md', 'x'),
        // Base `agents-md-3`, read after `agents-md` took that slug in this scan: it gets `-2`.
        scanned('5/AGENTS.md', 'x', 'agents-md-3'),
        scanned('6/AGENTS.md', 'x'),
      ],
    });
    expect(await slugsByPath(handle)).toEqual([
      ['repo', '1/AGENTS.md', 'agents-md-3'],
      ['repo', '2/AGENTS.md', 'agents-md-6'],
      ['repo', '3/AGENTS.md', 'agents-md-5'],
      ['repo', '4/AGENTS.md', 'agents-md-7'],
      ['repo', '5/AGENTS.md', 'agents-md-3-2'],
      ['repo', '6/AGENTS.md', 'agents-md-8'],
      ['repo', 'AGENTS.md', 'agents-md'],
      ['repo', 'a/AGENTS.md', 'agents-md-2'],
      ['repo', 'b/AGENTS.md', 'agents-md-4'],
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
      commitSha: null,
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
        commitSha: null,
        repositoryId: other.repository.id,
        jobId: other.jobId,
        signal,
        artifacts: [scanned('AGENTS.md', 'x')],
      }),
    ).rejects.toThrow(NotFoundError);
    expect(await handle.db.$count(schema.artifacts)).toBe(0);
  });

  it('rolls back and reports the path when an artifact-level cause (its metadata) fails the write', async () => {
    // Core never hands over such metadata any more (parseFrontmatter rejects it); this guards
    // whatever else could fail while one artifact is written.
    const handle = getHandle();
    const { repository, jobId } = await runningScan(handle, '/srv/skills');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const broken = { ...scanned('docs/AGENTS.md', 'x'), parsedMetadata: { frontmatter: circular } };
    const failure = await applyRepositoryScan(handle, {
      commitSha: null,
      repositoryId: repository.id,
      jobId,
      signal,
      artifacts: [scanned('AGENTS.md', 'ok'), broken],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArtifactStoreError);
    expect(failure).toMatchObject({
      path: 'docs/AGENTS.md',
      message: 'Storing the scan results failed',
      cause: expect.any(TypeError),
    });
    expect(await handle.db.$count(schema.artifacts)).toBe(0);
  });

  it('reports a connection-level failure as an ArtifactStoreError at the path it stopped at', async () => {
    // A full database fails whichever artifact is written next: the error carries where, and the
    // SQLite cause says why (review of PR #44: the path must not be presented as the culprit).
    const handle = getHandle();
    const { repository, jobId } = await runningScan(handle, '/srv/skills');
    const { page_count: pages } = handle.sqlite.prepare('pragma page_count').get() as {
      page_count: number;
    };
    handle.sqlite.exec(`pragma max_page_count = ${pages}`);
    const failure = await applyRepositoryScan(handle, {
      commitSha: null,
      repositoryId: repository.id,
      jobId,
      signal,
      artifacts: [scanned('AGENTS.md', 'x'.repeat(256 * 1024))],
    }).catch((error: unknown) => error);
    handle.sqlite.exec('pragma max_page_count = 1073741823');
    expect(failure).toBeInstanceOf(ArtifactStoreError);
    expect(failure).toMatchObject({
      path: 'AGENTS.md',
      message: 'Storing the scan results failed',
    });
    const cause = (failure as ArtifactStoreError).cause as Error & { cause?: unknown };
    expect(cause.cause).toMatchObject({ errstr: 'database or disk is full' });
    expect(await handle.db.$count(schema.artifacts)).toBe(0);
  });

  it('writes nothing when its signal is aborted while it waits behind another transaction', async () => {
    // Runner shutdown aborts the signal but records nothing in the job row, so the transaction
    // must check the signal itself: the scan checked it before queueing, the abort came after.
    // The held transaction mirrors that wait; the runner test in repository-scan.test.ts proves
    // the wait itself, by shutting down once the apply transaction is queued.
    const handle = getHandle();
    const { repository, jobId } = await runningScan(handle, '/srv/skills');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withTransaction(handle, () => gate);
    const controller = new AbortController();
    const applied = applyRepositoryScan(handle, {
      commitSha: null,
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
        commitSha: null,
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
