import { idListFingerprint } from '@directivebench/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  MAX_BULK_CATEGORY_ARTIFACTS,
  assignArtifactCategory,
  createCategory,
  importArtifactVersion,
  listArtifactIds,
  listArtifacts,
  schema,
  setCategoryArchived,
  setCategoryForListedArtifacts,
  updateCategory,
  type ArtifactListFilter,
  type BulkCategoryMode,
  type DatabaseHandle,
} from '../src/index';
import { artifactInput } from './support/fixtures';
import { interceptHandle } from './support/intercept';
import { useTestDatabase } from './support/test-database';

// SPEC-124 Phase 4: `listArtifactIds` and `setCategoryForListedArtifacts` (FR-124-13, §8.2, §15).

const getHandle = useTestDatabase();

async function category(handle: DatabaseHandle, name: string) {
  const outcome = await createCategory(handle, { name, description: null });
  if (outcome.status !== 'created') throw new Error(`${name}: ${outcome.status}`);
  return outcome.category;
}

async function artifact(
  handle: DatabaseHandle,
  slug: string,
  options: { description?: string; repository?: string; type?: 'skill' | 'rule' } = {},
) {
  const input = artifactInput(slug, {
    slug,
    description: options.description ?? 'Validate input',
    type: options.type ?? 'skill',
    repository: {
      provider: 'local-directory',
      name: options.repository ?? 'fixtures',
      location: `/tmp/${options.repository ?? 'fixtures'}`,
    },
    path: `skills/${slug}`,
  });
  return (await importArtifactVersion(handle, input)).artifactId;
}

/**
 * Inserts `count` bare artifacts in one statement loop (setup for the size tests). `name(i)` may
 * repeat, so batches of the id scan meet ties on the name.
 */
function insertArtifacts(
  handle: DatabaseHandle,
  count: number,
  name: (i: number) => string = (i) => `bulk-${String(i).padStart(5, '0')}`,
): string[] {
  const now = new Date().toISOString();
  const insert = handle.sqlite.prepare(
    `insert into artifacts (id, slug, name, type, description, created_at, updated_at)
     values (?, ?, ?, 'skill', ?, ?, ?)`,
  );
  const ids: string[] = [];
  handle.sqlite.exec('begin');
  for (let i = 0; i < count; i += 1) {
    const id = `art_bulk${String(i).padStart(5, '0')}`;
    insert.run(id, `bulk-${i}`, name(i), i % 3 === 0 ? 'Ärger mit Eingaben' : null, now, now);
    ids.push(id);
  }
  handle.sqlite.exec('commit');
  return ids;
}

async function assignments(handle: DatabaseHandle, categoryId: string): Promise<string[]> {
  const rows = await handle.db
    .select({ artifactId: schema.artifactCategories.artifactId })
    .from(schema.artifactCategories)
    .where(eq(schema.artifactCategories.categoryId, categoryId));
  return rows.map((row) => row.artifactId).sort();
}

async function assignmentCount(handle: DatabaseHandle): Promise<number> {
  return handle.db.$count(schema.artifactCategories);
}

/** What the page posts: its filter and the fingerprint of the ids it listed. */
async function posted(handle: DatabaseHandle, filter: ArtifactListFilter = {}) {
  const ids = (await listArtifacts(handle.db, filter)).map((a) => a.id);
  return { filter, listFingerprint: idListFingerprint(ids) };
}

describe('listArtifactIds', () => {
  it('lists the ids listArtifacts lists, in its order, for every filter and their combinations', async () => {
    const handle = getHandle();
    await artifact(handle, 'alpha', { repository: 'team', description: 'Ärger mit Eingaben' });
    await artifact(handle, 'beta', { repository: 'client', type: 'rule' });
    await artifact(handle, 'gamma', { repository: 'team', type: 'rule' });
    const delta = await artifact(handle, 'delta', { repository: 'client' });
    const estimation = await category(handle, 'Estimation');
    await assignArtifactCategory(handle, delta, estimation.id);
    const [team] = (await listArtifacts(handle.db, { q: 'alpha' }))[0]?.repositories ?? [];
    const filters: ArtifactListFilter[] = [
      {},
      { q: 'ÄRGER' },
      { q: '  a  ' },
      { q: 'nothing matches' },
      { type: 'rule' },
      { category: 'estimation' },
      { category: 'unknown' },
      { repository: team?.id as string },
      { repository: team?.id as string, type: 'rule' },
      { q: 'a', type: 'skill', category: 'estimation', repository: 'repo_x' },
      { q: 'e', type: 'skill' },
    ];
    for (const filter of filters) {
      expect(await listArtifactIds(handle.db, filter), JSON.stringify(filter)).toEqual(
        (await listArtifacts(handle.db, filter)).map((a) => a.id),
      );
    }
    expect(await listArtifactIds(handle.db, { q: 'ärger' })).toHaveLength(1);
  });

  it('reads in batches across ties on the name and still equals listArtifacts', async () => {
    const handle = getHandle();
    // Seven names over 2,345 rows: every batch boundary falls inside a run of equal names.
    insertArtifacts(handle, 2_345, (i) => `same-${i % 7}`);
    for (const filter of [{}, { q: 'ärger' }, { q: 'same-3' }] satisfies ArtifactListFilter[]) {
      const ids = await listArtifactIds(handle.db, filter);
      expect(ids).toEqual((await listArtifacts(handle.db, filter)).map((a) => a.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(await listArtifactIds(handle.db)).toHaveLength(2_345);
  });
});

describe('setCategoryForListedArtifacts', () => {
  it('assigns to every listed artifact and counts those that already had it', async () => {
    const handle = getHandle();
    const alpha = await artifact(handle, 'alpha', { repository: 'team' });
    const beta = await artifact(handle, 'beta', { repository: 'team' });
    await artifact(handle, 'gamma', { repository: 'client' });
    const clientA = await category(handle, 'Client A');
    await assignArtifactCategory(handle, beta, clientA.id);
    const [team] = (await listArtifacts(handle.db, { q: 'alpha' }))[0]?.repositories ?? [];
    const filter = { repository: team?.id as string };
    expect(
      await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'assign',
        ...(await posted(handle, filter)),
      }),
    ).toEqual({ status: 'done', changed: 1, unchanged: 1, category: clientA });
    expect(await assignments(handle, clientA.id)).toEqual([alpha, beta].sort());
    // Again: nothing changes.
    expect(
      await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'assign',
        ...(await posted(handle, filter)),
      }),
    ).toEqual({ status: 'done', changed: 0, unchanged: 2, category: clientA });
  });

  it('removes from every listed artifact and counts those that did not have it', async () => {
    const handle = getHandle();
    const alpha = await artifact(handle, 'alpha');
    await artifact(handle, 'beta');
    const gamma = await artifact(handle, 'gamma', { type: 'rule' });
    const clientA = await category(handle, 'Client A');
    const other = await category(handle, 'Other');
    await assignArtifactCategory(handle, alpha, clientA.id);
    await assignArtifactCategory(handle, gamma, clientA.id);
    await assignArtifactCategory(handle, alpha, other.id);
    const filter: ArtifactListFilter = { type: 'skill' };
    expect(
      await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'remove',
        ...(await posted(handle, filter)),
      }),
    ).toEqual({ status: 'done', changed: 1, unchanged: 1, category: clientA });
    // The unlisted artifact and the other category keep their assignments.
    expect(await assignmentCount(handle)).toBe(2);
    expect((await listArtifacts(handle.db, { category: clientA.slug })).map((a) => a.id)).toEqual([
      gamma,
    ]);
  });

  it('names the category as it is now (renamed before the submit)', async () => {
    const handle = getHandle();
    await artifact(handle, 'alpha');
    const clientA = await category(handle, 'Client A');
    await updateCategory(handle, { id: clientA.id, name: 'Client B', description: null });
    expect(
      await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'assign',
        ...(await posted(handle)),
      }),
    ).toEqual({
      status: 'done',
      changed: 1,
      unchanged: 0,
      category: { ...clientA, name: 'Client B' },
    });
  });

  it('refuses a list that changed, also at the same count with a different id, and writes nothing', async () => {
    const handle = getHandle();
    await artifact(handle, 'alpha');
    const beta = await artifact(handle, 'beta');
    const clientA = await category(handle, 'Client A');
    const page = await posted(handle);
    // A scan adds an artifact: the count grows.
    await artifact(handle, 'gamma');
    for (const mode of ['assign', 'remove'] as const) {
      expect(
        await setCategoryForListedArtifacts(handle, { categoryId: clientA.id, mode, ...page }),
      ).toEqual({ status: 'list-changed', actualCount: 3 });
    }
    // The same count, one artifact swapped for another.
    const three = await posted(handle);
    handle.sqlite.prepare('delete from artifacts where id = ?').run(beta);
    await artifact(handle, 'delta');
    expect(
      await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'assign',
        ...three,
      }),
    ).toEqual({ status: 'list-changed', actualCount: 3 });
    expect(await assignmentCount(handle)).toBe(0);
  });

  it('refuses an empty list, which the page never offers the action on', async () => {
    const handle = getHandle();
    const clientA = await category(handle, 'Client A');
    expect(
      await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'assign',
        ...(await posted(handle)),
      }),
    ).toEqual({ status: 'list-changed', actualCount: 0 });
  });

  it('refuses an archived or unknown category in both modes, writing nothing', async () => {
    const handle = getHandle();
    const alpha = await artifact(handle, 'alpha');
    const python = await category(handle, 'Python');
    await assignArtifactCategory(handle, alpha, python.id);
    // Archived in another tab, committed before the submit's transaction.
    await setCategoryArchived(handle, { id: python.id, state: 'archived' });
    const page = await posted(handle);
    for (const mode of ['assign', 'remove'] satisfies BulkCategoryMode[]) {
      expect(
        await setCategoryForListedArtifacts(handle, { categoryId: python.id, mode, ...page }),
      ).toEqual({ status: 'category-archived', category: { ...python, archived: true } });
      expect(
        await setCategoryForListedArtifacts(handle, { categoryId: 'cat_missing', mode, ...page }),
      ).toEqual({ status: 'category-not-found' });
    }
    expect(await assignments(handle, python.id)).toEqual([alpha]);
  });

  it('refuses more than the limit, injected lower, with the count', async () => {
    const handle = getHandle();
    await artifact(handle, 'alpha');
    await artifact(handle, 'beta');
    await artifact(handle, 'gamma');
    const clientA = await category(handle, 'Client A');
    const page = await posted(handle);
    expect(
      await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'assign',
        ...page,
        limit: 2,
      }),
    ).toEqual({ status: 'too-many', actualCount: 3, limit: 2 });
    // Even more than limit + 1: the page cannot have offered it, so the list changed; the count
    // is read after the transaction.
    expect(
      await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'assign',
        ...page,
        limit: 1,
      }),
    ).toEqual({ status: 'list-changed', actualCount: 3 });
    expect(await assignmentCount(handle)).toBe(0);
    expect(MAX_BULK_CATEGORY_ARTIFACTS).toBe(10_000);
  });

  it('checks the fingerprint, then the category, then the limit', async () => {
    const handle = getHandle();
    await artifact(handle, 'alpha');
    await artifact(handle, 'beta');
    const python = await category(handle, 'Python');
    await setCategoryArchived(handle, { id: python.id, state: 'archived' });
    const page = await posted(handle);
    const wrong = { ...page, listFingerprint: idListFingerprint(['art_other']) };
    // A changed list wins over an unknown or archived category and over the limit.
    for (const categoryId of ['cat_missing', python.id]) {
      expect(
        await setCategoryForListedArtifacts(handle, {
          categoryId,
          mode: 'assign',
          ...wrong,
          limit: 1,
        }),
      ).toEqual({ status: 'list-changed', actualCount: 2 });
    }
    // An archived category wins over the limit.
    expect(
      await setCategoryForListedArtifacts(handle, {
        categoryId: python.id,
        mode: 'remove',
        ...page,
        limit: 1,
      }),
    ).toEqual({ status: 'category-archived', category: { ...python, archived: true } });
  });

  it('keeps every statement but the over-limit count inside its one transaction', async () => {
    const handle = getHandle();
    insertArtifacts(handle, 3);
    const clientA = await category(handle, 'Client A');
    const page = await posted(handle);
    const statements: boolean[] = [];
    const watched = interceptHandle(handle, () => {
      statements.push(handle.sqlite.isTransaction);
      return 'run';
    });
    expect(
      await setCategoryForListedArtifacts(watched, {
        categoryId: clientA.id,
        mode: 'assign',
        ...page,
      }),
    ).toMatchObject({ status: 'done', changed: 3 });
    // The id scan, the category read and the insert.
    expect(statements).toEqual([true, true, true]);
    statements.length = 0;
    expect(
      await setCategoryForListedArtifacts(watched, {
        categoryId: clientA.id,
        mode: 'assign',
        ...page,
        limit: 1,
      }),
    ).toEqual({ status: 'list-changed', actualCount: 3 });
    // The bounded scan inside the transaction, then the count outside the write lock.
    expect(statements).toEqual([true, false]);
  });

  it('is all or nothing when a later batch of the write fails', async () => {
    const handle = getHandle();
    // 1,200 artifacts: three insert batches; the trigger fails the last row of the last one.
    const ids = insertArtifacts(handle, 1_200);
    const clientA = await category(handle, 'Client A');
    const page = await posted(handle);
    const last = ids.at(-1) as string;
    handle.sqlite.exec(`
      create trigger refuse_insert before insert on artifact_categories
      when new.artifact_id = '${last}' begin select raise(abort, 'refused by trigger'); end;
    `);
    await expect(
      setCategoryForListedArtifacts(handle, { categoryId: clientA.id, mode: 'assign', ...page }),
    ).rejects.toHaveProperty('cause.message', 'refused by trigger');
    expect(await assignmentCount(handle)).toBe(0);

    handle.sqlite.exec('drop trigger refuse_insert');
    await setCategoryForListedArtifacts(handle, {
      categoryId: clientA.id,
      mode: 'assign',
      ...page,
    });
    handle.sqlite.exec(`
      create trigger refuse_delete before delete on artifact_categories
      when old.artifact_id = '${last}' begin select raise(abort, 'refused by trigger'); end;
    `);
    await expect(
      setCategoryForListedArtifacts(handle, { categoryId: clientA.id, mode: 'remove', ...page }),
    ).rejects.toHaveProperty('cause.message', 'refused by trigger');
    expect(await assignmentCount(handle)).toBe(1_200);
    expect(handle.sqlite.isTransaction).toBe(false);
  });

  it(
    'assigns and removes 10,000 artifacts (NFR-124-01, timed once, not enforced)',
    { timeout: 120_000 },
    async ({ annotate }) => {
      const handle = getHandle();
      insertArtifacts(handle, MAX_BULK_CATEGORY_ARTIFACTS);
      const clientA = await category(handle, 'Client A');
      const page = await posted(handle);
      const started = performance.now();
      const assigned = await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'assign',
        ...page,
      });
      const assignMs = performance.now() - started;
      const startedQ = performance.now();
      const removed = await setCategoryForListedArtifacts(handle, {
        categoryId: clientA.id,
        mode: 'remove',
        ...(await posted(handle, { q: 'bulk' })),
      });
      const removeMs = performance.now() - startedQ;
      expect(assigned).toMatchObject({ status: 'done', changed: 10_000, unchanged: 0 });
      expect(removed).toMatchObject({ status: 'done', changed: 10_000, unchanged: 0 });
      await annotate(
        `bulk assign of 10,000: ${assignMs.toFixed(0)} ms; bulk remove with q: ${removeMs.toFixed(0)} ms`,
      );
    },
  );
});
