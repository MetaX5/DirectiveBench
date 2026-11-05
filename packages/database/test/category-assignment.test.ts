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
  it('assigns an active category once', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const estimation = await category(handle, 'Estimation');
    expect(await assignArtifactCategory(handle.db, artifactId, estimation.id)).toBe('assigned');
    expect(await assignArtifactCategory(handle.db, artifactId, estimation.id)).toBe(
      'already-assigned',
    );
    expect(await assignmentCount(handle)).toBe(1);
  });

  it('refuses an archived category, also when the artifact already has it', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    const ruby = await category(handle, 'Ruby');
    await assignArtifactCategory(handle.db, artifactId, ruby.id);
    for (const { id } of [python, ruby]) {
      await setCategoryArchived(handle, { id, state: 'archived' });
      expect(await assignArtifactCategory(handle.db, artifactId, id)).toBe('category-archived');
    }
    expect(await assignmentCount(handle)).toBe(1);
  });

  it('reports a missing category or artifact and writes nothing', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const estimation = await category(handle, 'Estimation');
    expect(await assignArtifactCategory(handle.db, artifactId, 'cat_missing')).toBe(
      'category-not-found',
    );
    expect(await assignArtifactCategory(handle.db, 'art_missing', estimation.id)).toBe(
      'artifact-not-found',
    );
    expect(await assignmentCount(handle)).toBe(0);
  });
});

describe('unassignArtifactCategory', () => {
  it('removes an assignment once, archived categories included', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    await assignArtifactCategory(handle.db, artifactId, python.id);
    await setCategoryArchived(handle, { id: python.id, state: 'archived' });
    expect(await unassignArtifactCategory(handle.db, artifactId, python.id)).toBe('removed');
    expect(await unassignArtifactCategory(handle.db, artifactId, python.id)).toBe('not-assigned');
    expect(await assignmentCount(handle)).toBe(0);
  });

  it('reports a missing category or artifact', async () => {
    const handle = getHandle();
    const artifactId = await artifact(handle);
    const python = await category(handle, 'Python');
    expect(await unassignArtifactCategory(handle.db, artifactId, 'cat_missing')).toBe(
      'category-not-found',
    );
    expect(await unassignArtifactCategory(handle.db, 'art_missing', python.id)).toBe(
      'artifact-not-found',
    );
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
    for (const name of ['Zeta', 'Alpha', 'Beta', 'Gamma']) {
      const { id } = await category(handle, name);
      await assignArtifactCategory(handle.db, artifactId, id);
      if (name === 'Alpha' || name === 'Gamma') {
        await setCategoryArchived(handle, { id, state: 'archived' });
      }
    }
    const expected = [
      { slug: 'beta', name: 'Beta', archived: false },
      { slug: 'zeta', name: 'Zeta', archived: false },
      { slug: 'alpha', name: 'Alpha', archived: true },
      { slug: 'gamma', name: 'Gamma', archived: true },
    ];
    expect((await listArtifacts(handle.db))[0]?.categories).toEqual(expected);
    expect((await getArtifactDetail(handle.db, artifactId))?.categories).toEqual(expected);
    // Filtering by an archived slug still works (FR-106-08).
    expect((await listArtifacts(handle.db, { category: 'alpha' })).map((a) => a.id)).toEqual([
      artifactId,
    ]);
  });
});
