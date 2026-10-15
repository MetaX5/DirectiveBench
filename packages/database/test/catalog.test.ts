import { eq } from 'drizzle-orm';
import { PREDEFINED_CATEGORIES } from '@directivebench/core';
import { describe, expect, it } from 'vitest';
import {
  assignCategoriesBySlug,
  finishBenchmarkRun,
  getDashboardStats,
  importArtifactVersion,
  listCategories,
  listRepositories,
  schema,
  seedPredefinedCategories,
} from '../src/index';
import { artifactInput, seedRun, seedTargets } from './support/fixtures';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

describe('seedPredefinedCategories', () => {
  it('seeds predefined categories once and keeps user changes', async () => {
    const { db } = getHandle();
    expect(await seedPredefinedCategories(db)).toBe(PREDEFINED_CATEGORIES.length);
    await db
      .update(schema.categories)
      .set({ name: 'Sec', archivedAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(schema.categories.slug, 'security'));
    expect(await seedPredefinedCategories(db)).toBe(0);

    const list = await listCategories(db);
    expect(list).toHaveLength(PREDEFINED_CATEGORIES.length);
    expect(list.find((c) => c.slug === 'security')).toMatchObject({
      name: 'Sec',
      predefined: true,
      archivedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('listCategories', () => {
  it('orders by name and counts assigned artifacts', async () => {
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const a = await importArtifactVersion(handle, artifactInput('a', { slug: 'a' }));
    const b = await importArtifactVersion(handle, artifactInput('b', { slug: 'b' }));
    await assignCategoriesBySlug(handle.db, a.artifactId, ['security', 'testing']);
    await assignCategoriesBySlug(handle.db, b.artifactId, ['security']);

    const list = await listCategories(handle.db);
    const names = list.map((c) => c.name);
    expect(names).toEqual([...names].sort());
    const counts = Object.fromEntries(list.map((c) => [c.slug, Number(c.artifactCount)]));
    expect(counts).toMatchObject({ security: 2, testing: 1 });
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(3);
  });
});

describe('listRepositories', () => {
  it('lists repositories by name', async () => {
    const handle = getHandle();
    await importArtifactVersion(
      handle,
      artifactInput('a', { repository: { provider: 'github', name: 'zeta', location: 'z' } }),
    );
    await importArtifactVersion(
      handle,
      artifactInput('a', { repository: { provider: 'gitlab', name: 'alpha', location: 'a' } }),
    );
    const repos = await listRepositories(handle.db);
    expect(repos.map((r) => [r.name, r.provider, r.syncStatus])).toEqual([
      ['alpha', 'gitlab', 'never'],
      ['zeta', 'github', 'never'],
    ]);
  });
});

describe('getDashboardStats', () => {
  it('reports zeros for an empty database', async () => {
    expect(await getDashboardStats(getHandle().db)).toEqual({
      repositoryCount: 0,
      artifactCount: 0,
      skillCount: 0,
      instructionCount: 0,
      ruleCount: 0,
      lastSyncAt: null,
      runsByVerdict: {},
      recentRuns: [],
    });
  });

  it('counts artifacts by type, the latest sync and recent runs', async () => {
    const handle = getHandle();
    const targets = await seedTargets(handle);
    await importArtifactVersion(handle, artifactInput('r1', { slug: 'r1', type: 'rule' }));
    await importArtifactVersion(handle, artifactInput('r2', { slug: 'r2', type: 'rule' }));
    await importArtifactVersion(
      handle,
      artifactInput('i1', {
        slug: 'i1',
        type: 'instruction',
        repository: { provider: 'local-git', name: 'other', location: '/srv/other' },
      }),
    );
    await handle.db
      .update(schema.repositories)
      .set({ lastSyncAt: '2026-01-01T00:00:00.000Z', syncStatus: 'ok' })
      .where(eq(schema.repositories.name, 'fixtures'));
    await handle.db
      .update(schema.repositories)
      .set({ lastSyncAt: '2026-02-01T00:00:00.000Z', syncStatus: 'ok' })
      .where(eq(schema.repositories.name, 'other'));
    const runId = await seedRun(handle, targets);
    await seedRun(handle, targets);
    await finishBenchmarkRun(handle.db, runId, {
      status: 'completed',
      verdict: 'regressed',
      summary: null,
      comparabilityKey: null,
      warnings: [],
      error: null,
    });

    const stats = await getDashboardStats(handle.db);
    expect(stats).toMatchObject({
      repositoryCount: 2,
      artifactCount: 4,
      skillCount: 1,
      instructionCount: 1,
      ruleCount: 2,
      lastSyncAt: '2026-02-01T00:00:00.000Z',
      runsByVerdict: { regressed: 1, running: 1 },
    });
    expect(stats.recentRuns).toHaveLength(2);
  });
});
