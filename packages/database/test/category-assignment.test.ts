import { describe, expect, it } from 'vitest';
import {
  assignArtifactCategory,
  assignCategoriesBySlug,
  createCategory,
  getArtifactDetail,
  importArtifactVersion,
  listArtifacts,
  schema,
  seedPredefinedCategories,
  setCategoryArchived,
  unassignArtifactCategory,
  updateCategory,
  type DatabaseHandle,
} from '../src/index';
import { artifactInput } from './support/fixtures';
import { interceptHandle } from './support/intercept';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

async function category(handle: DatabaseHandle, name: string) {
  const outcome = await createCategory(handle, { name, description: null });
  if (outcome.status !== 'created') throw new Error(`${name}: ${outcome.status}`);
  return outcome.category;
}

async function artifact(handle: DatabaseHandle, slug = 'validate') {
  return (await importArtifactVersion(handle, artifactInput(slug, { slug }))).artifactId;
}

async function assignmentCount(handle: DatabaseHandle) {
  return handle.db.$count(schema.artifactCategories);
}

describe('assignArtifactCategory', () => {
  it('assigns an active category once and names it', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const estimation = await category(handle, 'Estimation');
    expect(await assignArtifactCategory(handle, artifactId, estimation.id)).toEqual({
      status: 'assigned',
      category: estimation,
    });
    expect(await assignArtifactCategory(handle, artifactId, estimation.id)).toEqual({
      status: 'already-assigned',
      category: estimation,
    });
    expect(await assignmentCount(handle)).toBe(1);
  });

  it('names the category as it is after the write (renamed elsewhere)', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const estimation = await category(handle, 'Estimation');
    await updateCategory(handle, { id: estimation.id, name: 'Sizing', description: null });
    const outcome = await assignArtifactCategory(handle, artifactId, estimation.id);
    expect(outcome).toEqual({ status: 'assigned', category: { ...estimation, name: 'Sizing' } });
  });

  it('refuses an archived category, also when the artifact already has it', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    const ruby = await category(handle, 'Ruby');
    await assignArtifactCategory(handle, artifactId, ruby.id);
    for (const ref of [python, ruby]) {
      await setCategoryArchived(handle, { id: ref.id, state: 'archived' });
      expect(await assignArtifactCategory(handle, artifactId, ref.id)).toEqual({
        status: 'category-archived',
        category: { ...ref, archived: true },
      });
    }
    expect(await assignmentCount(handle)).toBe(1);
  });

  it('inserts and explains a no-op in one transaction, so no archive or unarchive lands between', async () => {
    // Codex review on PR 198: an unarchive between the no-op insert and the read made the
    // outcome "already-assigned" without an assignment. BEGIN IMMEDIATE keeps every other writer
    // out until the function returns; here every statement must run inside that transaction.
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    await setCategoryArchived(handle, { id: python.id, state: 'archived' });
    const statements: boolean[] = [];
    const watched = interceptHandle(handle, () => {
      statements.push(handle.sqlite.isTransaction);
      return 'run';
    });
    expect(await assignArtifactCategory(watched, artifactId, python.id)).toEqual({
      status: 'category-archived',
      category: { ...python, archived: true },
    });
    // The insert, the category read and the artifact check.
    expect(statements).toEqual([true, true, true]);
    expect(handle.sqlite.isTransaction).toBe(false);
    expect(await assignmentCount(handle)).toBe(0);
  });

  it('reports a missing category or artifact and writes nothing', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const estimation = await category(handle, 'Estimation');
    expect(await assignArtifactCategory(handle, artifactId, 'cat_missing')).toEqual({
      status: 'category-not-found',
    });
    expect(await assignArtifactCategory(handle, 'art_missing', estimation.id)).toEqual({
      status: 'artifact-not-found',
    });
    expect(await assignArtifactCategory(handle, 'art_missing', 'cat_missing')).toEqual({
      status: 'category-not-found',
    });
    expect(await assignmentCount(handle)).toBe(0);
  });
});

describe('unassignArtifactCategory', () => {
  it('removes an assignment once, archived categories included, and names it', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    await assignArtifactCategory(handle, artifactId, python.id);
    await setCategoryArchived(handle, { id: python.id, state: 'archived' });
    const archived = { ...python, archived: true };
    expect(await unassignArtifactCategory(handle.db, artifactId, python.id)).toEqual({
      status: 'removed',
      category: archived,
    });
    expect(await unassignArtifactCategory(handle.db, artifactId, python.id)).toEqual({
      status: 'not-assigned',
      category: archived,
    });
    expect(await assignmentCount(handle)).toBe(0);
  });

  it('names the category as it is after the write (renamed elsewhere)', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    await assignArtifactCategory(handle, artifactId, python.id);
    await updateCategory(handle, { id: python.id, name: 'Py', description: null });
    expect(await unassignArtifactCategory(handle.db, artifactId, python.id)).toEqual({
      status: 'removed',
      category: { ...python, name: 'Py' },
    });
  });

  it('reports a missing category or artifact', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    expect(await unassignArtifactCategory(handle.db, artifactId, 'cat_missing')).toEqual({
      status: 'category-not-found',
    });
    expect(await unassignArtifactCategory(handle.db, 'art_missing', python.id)).toEqual({
      status: 'artifact-not-found',
    });
  });
});

describe('assignCategoriesBySlug', () => {
  it('never assigns a category archived between the lookup and the write (SPEC-124 §8.2)', async () => {
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const artifactId = await artifact(handle);
    // Another process archives "security" right before the importer's insert reaches SQLite.
    const racing = interceptHandle(handle, (query) => {
      if (query.startsWith('insert into "artifact_categories"')) {
        handle.sqlite.exec("update categories set archived_at = 't' where slug = 'security'");
      }
      return 'run';
    });
    expect(await assignCategoriesBySlug(racing.db, artifactId, ['security'])).toEqual({
      assigned: [],
      unknown: ['security'],
    });
    expect(await assignmentCount(handle)).toBe(0);
  });

  it('reports each slug once in input order and repeats of an unknown slug as given', async () => {
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const artifactId = await artifact(handle);
    expect(
      await assignCategoriesBySlug(handle.db, artifactId, [
        'testing',
        'nope',
        'security',
        'testing',
        'nope',
      ]),
    ).toEqual({ assigned: ['testing', 'security'], unknown: ['nope', 'nope'] });
    expect(await assignmentCount(handle)).toBe(2);
  });
});

describe('assigned categories on the artifact list and page', () => {
  it('carry archived and list active ones first, each group by name', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const ids = new Map<string, string>();
    for (const name of ['Zeta', 'Alpha', 'Beta', 'Gamma']) {
      const { id } = await category(handle, name);
      ids.set(name, id);
      await assignArtifactCategory(handle, artifactId, id);
      if (name === 'Alpha' || name === 'Gamma') {
        await setCategoryArchived(handle, { id, state: 'archived' });
      }
    }
    const expected = [
      { id: ids.get('Beta'), slug: 'beta', name: 'Beta', archived: false },
      { id: ids.get('Zeta'), slug: 'zeta', name: 'Zeta', archived: false },
      { id: ids.get('Alpha'), slug: 'alpha', name: 'Alpha', archived: true },
      { id: ids.get('Gamma'), slug: 'gamma', name: 'Gamma', archived: true },
    ];
    expect((await listArtifacts(handle.db))[0]?.categories).toEqual(expected);
    expect((await getArtifactDetail(handle.db, artifactId))?.categories).toEqual(expected);
    // Filtering by an archived slug still works (FR-106-08).
    expect((await listArtifacts(handle.db, { category: 'alpha' })).map((a) => a.id)).toEqual([
      artifactId,
    ]);
  });
});
