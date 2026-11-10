import { describe, expect, it } from 'vitest';
import {
  ASSIGN_CATEGORY_ATTEMPTS,
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
    expect(await assignArtifactCategory(handle.db, artifactId, estimation.id)).toEqual({
      status: 'assigned',
      category: estimation,
    });
    expect(await assignArtifactCategory(handle.db, artifactId, estimation.id)).toEqual({
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
    const outcome = await assignArtifactCategory(handle.db, artifactId, estimation.id);
    expect(outcome).toEqual({ status: 'assigned', category: { ...estimation, name: 'Sizing' } });
  });

  it('refuses an archived category, also when the artifact already has it', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    const ruby = await category(handle, 'Ruby');
    await assignArtifactCategory(handle.db, artifactId, ruby.id);
    for (const ref of [python, ruby]) {
      await setCategoryArchived(handle, { id: ref.id, state: 'archived' });
      expect(await assignArtifactCategory(handle.db, artifactId, ref.id)).toEqual({
        status: 'category-archived',
        category: { ...ref, archived: true },
      });
    }
    expect(await assignmentCount(handle)).toBe(1);
  });

  /**
   * A handle on which another process archives the category right before each of the first
   * `races` assignment inserts and unarchives it right before the follow-up read, so the insert
   * is a no-op although the read sees an active category (Codex review on PR 198).
   */
  function racingArchive(handle: DatabaseHandle, categoryId: string, races: number) {
    const seen = { inserts: 0, unarchives: 0 };
    let raced = false;
    const racing = interceptHandle(handle, (query) => {
      if (query.startsWith('insert into "artifact_categories"')) {
        seen.inserts += 1;
        if (seen.inserts <= races) {
          handle.sqlite
            .prepare('update categories set archived_at = ? where id = ?')
            .run('t', categoryId);
          raced = true;
        }
      } else if (raced && query.startsWith('select') && query.includes('from "categories"')) {
        handle.sqlite
          .prepare('update categories set archived_at = null where id = ?')
          .run(categoryId);
        seen.unarchives += 1;
        raced = false;
      }
      return 'run';
    });
    return { racing, seen };
  }

  it('assigns after all when an unarchive lands between its no-op insert and the read', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    const { racing, seen } = racingArchive(handle, python.id, 1);
    expect(await assignArtifactCategory(racing.db, artifactId, python.id)).toEqual({
      status: 'assigned',
      category: python,
    });
    // The race happened once and the insert ran again.
    expect(seen).toEqual({ inserts: 2, unarchives: 1 });
    expect(await assignmentCount(handle)).toBe(1);
  });

  it('never reports "already assigned" without the assignment, however often the race repeats', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    const { racing, seen } = racingArchive(handle, python.id, Infinity);
    expect(await assignArtifactCategory(racing.db, artifactId, python.id)).toEqual({
      status: 'category-archived',
      category: python,
    });
    expect(seen).toEqual({
      inserts: ASSIGN_CATEGORY_ATTEMPTS,
      unarchives: ASSIGN_CATEGORY_ATTEMPTS,
    });
    expect(await assignmentCount(handle)).toBe(0);
  });

  it('reports a missing category or artifact and writes nothing', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const estimation = await category(handle, 'Estimation');
    expect(await assignArtifactCategory(handle.db, artifactId, 'cat_missing')).toEqual({
      status: 'category-not-found',
    });
    expect(await assignArtifactCategory(handle.db, 'art_missing', estimation.id)).toEqual({
      status: 'artifact-not-found',
    });
    expect(await assignArtifactCategory(handle.db, 'art_missing', 'cat_missing')).toEqual({
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
    await assignArtifactCategory(handle.db, artifactId, python.id);
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
    await assignArtifactCategory(handle.db, artifactId, python.id);
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
      await assignArtifactCategory(handle.db, artifactId, id);
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
