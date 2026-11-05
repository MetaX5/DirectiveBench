import { eq } from 'drizzle-orm';
import { CATEGORY_SLUG_MAX_LENGTH, PREDEFINED_CATEGORIES } from '@directivebench/core';
import { describe, expect, it } from 'vitest';
import {
  assignCategoriesBySlug,
  createCategory,
  getCategoryBySlug,
  importArtifactVersion,
  listCategories,
  schema,
  seedPredefinedCategories,
  setCategoryArchived,
  updateCategory,
  type DatabaseHandle,
} from '../src/index';
import { artifactInput } from './support/fixtures';
import { interceptHandle, type InterceptAction } from './support/intercept';
import { useTestDatabase } from './support/test-database';

const getHandle = useTestDatabase();

/** The slug shape of the `[slug]` route and the Artifacts `category` filter (apps/web). */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Runs `write` on a handle where the first statement matching `pattern` sees no rows, so the clash
 * check misses and the write reaches the unique index. Asserts the hide happened: if Drizzle's SQL
 * text stopped matching, the ordinary check would return the same outcome and the test would pass
 * without reaching the backstop.
 */
async function withMissedCheck<T>(
  handle: DatabaseHandle,
  pattern: RegExp,
  write: (intercepted: DatabaseHandle) => Promise<T>,
): Promise<T> {
  let hidden = 0;
  const result = await write(
    interceptHandle(handle, (query): InterceptAction => {
      if (hidden > 0 || !pattern.test(query)) return 'run';
      hidden += 1;
      return 'hide';
    }),
  );
  expect(hidden, `no statement matched ${pattern}`).toBe(1);
  return result;
}
const NAME_KEY_LOOKUP = /^select .* where .*"categories"\."name_key" = \?/;
const SLUG_LOOKUP = /^select .* where "categories"\."slug" = \?/;
const GENERATED_SLUG_LOOKUP = /^select "slug" from "categories" where .*"slug" >= \?/;

async function row(handle: DatabaseHandle, id: string) {
  return handle.db.select().from(schema.categories).where(eq(schema.categories.id, id)).get();
}

async function categoryId(handle: DatabaseHandle, slug: string): Promise<string> {
  const found = await getCategoryBySlug(handle.db, slug);
  if (!found) throw new Error(`no category ${slug}`);
  return found.id;
}

async function created(handle: DatabaseHandle, name: string, description: string | null = null) {
  const outcome = await createCategory(handle, { name, description });
  if (outcome.status !== 'created') throw new Error(`${name}: ${outcome.status}`);
  return outcome.category;
}

describe('createCategory', () => {
  it('stores the normalised name, its key and the derived slug, as an active user category', async () => {
    const handle = getHandle();
    const outcome = await createCategory(handle, {
      name: '  Client \t A ',
      description: 'Work for client A',
    });
    expect(outcome).toEqual({
      status: 'created',
      category: {
        id: expect.stringMatching(/^cat_/),
        slug: 'client-a',
        name: 'Client A',
        archived: false,
      },
    });
    if (outcome.status !== 'created') return;
    expect(await row(handle, outcome.category.id)).toMatchObject({
      slug: 'client-a',
      name: 'Client A',
      nameKey: 'client a',
      description: 'Work for client A',
      predefined: false,
      archivedAt: null,
    });
    expect((await listCategories(handle.db)).map((c) => c.slug)).toEqual(['client-a']);
  });

  it('refuses a name whose key an active category holds, in any case or spacing', async () => {
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const testing = await getCategoryBySlug(handle.db, 'testing');
    for (const name of ['testing ', 'TESTING', ' Testing']) {
      expect(await createCategory(handle, { name, description: null })).toEqual({
        status: 'name-taken',
        existing: { id: testing?.id, slug: 'testing', name: 'Testing', archived: false },
      });
    }
    const umlaut = await created(handle, 'Ärger');
    expect(await createCategory(handle, { name: 'ärger', description: null })).toEqual({
      status: 'name-taken',
      existing: umlaut,
    });
    expect(await handle.db.$count(schema.categories)).toBe(PREDEFINED_CATEGORIES.length + 1);
  });

  it('refuses a slug another category holds, active or archived (A7, A10)', async () => {
    const handle = getHandle();
    const c = await created(handle, 'C');
    expect(await createCategory(handle, { name: 'C#', description: null })).toEqual({
      status: 'slug-taken',
      existing: c,
    });
    const cafe = await created(handle, 'Café');
    expect(await createCategory(handle, { name: 'Cafe', description: null })).toEqual({
      status: 'slug-taken',
      existing: cafe,
    });

    const python = await created(handle, 'Python');
    await setCategoryArchived(handle, { id: python.id, state: 'archived' });
    // The archived name is free, but its slug is not.
    expect(await createCategory(handle, { name: 'python', description: null })).toEqual({
      status: 'slug-taken',
      existing: { ...python, archived: true },
    });
    expect(await handle.db.$count(schema.categories)).toBe(3);
  });

  it('generates the smallest free category-N for names without a Latin letter or digit (A5)', async () => {
    const handle = getHandle();
    expect((await created(handle, '日本語')).slug).toBe('category-1');
    expect((await created(handle, '!!!')).slug).toBe('category-2');

    // A number held by an archived row or a derived slug is skipped; category-07 holds nothing.
    const archived = await created(handle, 'Ελληνικά');
    expect(archived.slug).toBe('category-3');
    await setCategoryArchived(handle, { id: archived.id, state: 'archived' });
    expect((await created(handle, 'Category 4')).slug).toBe('category-4');
    expect((await created(handle, 'Category 07')).slug).toBe('category-07');
    expect((await created(handle, 'Русский')).slug).toBe('category-5');

    // A derived slug equal to a generated one is refused like any other.
    expect(await createCategory(handle, { name: 'Category 1', description: null })).toMatchObject({
      status: 'slug-taken',
      existing: { slug: 'category-1', name: '日本語' },
    });
    // "日本語 2" has a digit, so its slug is derived.
    expect((await created(handle, '日本語 2')).slug).toBe('2');
  });

  it('keeps generated slugs short after a 64-character derived category-999…9', async () => {
    const handle = getHandle();
    const nines = await created(handle, `Category ${'9'.repeat(55)}`);
    expect(nines.slug).toHaveLength(CATEGORY_SLUG_MAX_LENGTH);
    for (const name of ['日本語', '中文']) {
      const { slug } = await created(handle, name);
      expect(slug).toMatch(SLUG_PATTERN);
      expect(slug.length).toBeLessThanOrEqual(CATEGORY_SLUG_MAX_LENGTH);
      expect(await getCategoryBySlug(handle.db, slug)).toMatchObject({ name });
    }
    expect((await listCategories(handle.db)).map((c) => c.slug).sort()).toEqual([
      'category-1',
      'category-2',
      nines.slug,
    ]);
  });

  it('maps a name-key violation the check missed to name-taken (index backstop)', async () => {
    const handle = getHandle();
    // Names without a Latin letter get different generated slugs, so only the key clashes.
    const first = await created(handle, '日本語');
    const outcome = await withMissedCheck(handle, NAME_KEY_LOOKUP, (h) =>
      createCategory(h, {
        name: '日本語 ',
        description: null,
      }),
    );
    expect(outcome).toEqual({ status: 'name-taken', existing: first });
    expect(await handle.db.$count(schema.categories)).toBe(1);
  });

  it('maps a derived or generated slug violation the check missed to slug-taken', async () => {
    const handle = getHandle();
    const c = await created(handle, 'C');
    expect(
      await withMissedCheck(handle, SLUG_LOOKUP, (h) =>
        createCategory(h, {
          name: 'C#',
          description: null,
        }),
      ),
    ).toEqual({ status: 'slug-taken', existing: c });

    const generated = await created(handle, '日本語');
    expect(
      await withMissedCheck(handle, GENERATED_SLUG_LOOKUP, (h) =>
        createCategory(h, {
          name: '中文',
          description: null,
        }),
      ),
    ).toEqual({ status: 'slug-taken', existing: generated });
    expect(await handle.db.$count(schema.categories)).toBe(2);
  });

  it('rethrows a unique violation it cannot explain, and any other error', async () => {
    const handle = getHandle();
    // The trigger's clashing row rolls back with the failed insert, so no row explains it.
    handle.sqlite.exec(`
      create trigger clash before insert on categories when new.slug = 'boom' begin
        insert into categories (id, slug, name, name_key, created_at, updated_at)
          values ('cat_ghost', 'boom', 'ghost', 'ghost', 't', 't');
      end;
      create trigger refuse before insert on categories when new.slug = 'refused' begin
        select raise(abort, 'refused by trigger');
      end;
    `);
    await expect(
      createCategory(handle, { name: 'Boom', description: null }),
    ).rejects.toHaveProperty(
      'cause.message',
      expect.stringMatching(/UNIQUE constraint failed: categories\.slug/),
    );
    await expect(
      createCategory(handle, { name: 'Refused', description: null }),
    ).rejects.toHaveProperty('cause.message', 'refused by trigger');
    expect(await handle.db.$count(schema.categories)).toBe(0);
  });
});

describe('updateCategory', () => {
  it('renames and describes a predefined category, keeping slug, flag and assignments', async () => {
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const { artifactId } = await importArtifactVersion(handle, artifactInput('v1'));
    await assignCategoriesBySlug(handle.db, artifactId, ['devops']);
    const id = await categoryId(handle, 'devops');

    expect(
      await updateCategory(handle, { id, name: ' CI  and Ops ', description: 'Pipelines' }),
    ).toEqual({
      status: 'updated',
      category: { id, slug: 'devops', name: 'CI and Ops', archived: false },
    });
    expect(await getCategoryBySlug(handle.db, 'devops')).toEqual({
      id,
      slug: 'devops',
      name: 'CI and Ops',
      archived: false,
      description: 'Pipelines',
      predefined: true,
      artifactCount: 1,
    });
    expect(await row(handle, id)).toMatchObject({ nameKey: 'ci and ops' });
    // The old name's key is free again, but the slug stays with the renamed category.
    expect(await createCategory(handle, { name: 'DevOps', description: null })).toEqual({
      status: 'slug-taken',
      existing: { id, slug: 'devops', name: 'CI and Ops', archived: false },
    });
  });

  it('reports unchanged values and allows a case-only rename', async () => {
    const handle = getHandle();
    const security = await created(handle, 'Security', 'Hardening');
    const before = await row(handle, security.id);
    expect(
      await updateCategory(handle, {
        id: security.id,
        name: ' Security',
        description: 'Hardening',
      }),
    ).toEqual({ status: 'unchanged', category: security });
    expect(await row(handle, security.id)).toEqual(before);

    expect(
      await updateCategory(handle, { id: security.id, name: 'security', description: 'Hardening' }),
    ).toEqual({ status: 'updated', category: { ...security, name: 'security' } });
    expect(
      await updateCategory(handle, { id: security.id, name: 'security', description: null }),
    ).toEqual({ status: 'updated', category: { ...security, name: 'security' } });
    expect(await row(handle, security.id)).toMatchObject({
      description: null,
      nameKey: 'security',
    });
  });

  it('refuses an active rename into another active key, allows it while archived, then refuses unarchive', async () => {
    const handle = getHandle();
    const testing = await created(handle, 'Testing');
    const python = await created(handle, 'Python');
    expect(
      await updateCategory(handle, { id: python.id, name: 'TESTING', description: null }),
    ).toEqual({ status: 'name-taken', existing: testing });
    expect(await row(handle, python.id)).toMatchObject({ name: 'Python', nameKey: 'python' });

    await setCategoryArchived(handle, { id: python.id, state: 'archived' });
    expect(
      await updateCategory(handle, { id: python.id, name: 'Testing', description: null }),
    ).toEqual({ status: 'updated', category: { ...python, name: 'Testing', archived: true } });
    expect(await setCategoryArchived(handle, { id: python.id, state: 'active' })).toEqual({
      status: 'name-taken',
      existing: testing,
    });
    expect(await row(handle, python.id)).toMatchObject({ archivedAt: expect.any(String) });
  });

  it('reports a category that does not exist', async () => {
    expect(
      await updateCategory(getHandle(), { id: 'cat_missing', name: 'X', description: null }),
    ).toEqual({ status: 'not-found' });
  });

  it('maps a name-key violation the check missed to name-taken, and rethrows one it cannot explain', async () => {
    const handle = getHandle();
    const testing = await created(handle, 'Testing');
    const python = await created(handle, 'Python');
    expect(
      await withMissedCheck(handle, NAME_KEY_LOOKUP, (h) =>
        updateCategory(h, {
          id: python.id,
          name: 'testing',
          description: null,
        }),
      ),
    ).toEqual({ status: 'name-taken', existing: testing });

    handle.sqlite.exec(`
      create trigger clash before update on categories when new.name = 'Boom' begin
        insert into categories (id, slug, name, name_key, created_at, updated_at)
          values ('cat_ghost', 'ghost', 'ghost', 'boom', 't', 't');
      end;
    `);
    await expect(
      updateCategory(handle, { id: python.id, name: 'Boom', description: null }),
    ).rejects.toHaveProperty(
      'cause.message',
      expect.stringMatching(/UNIQUE constraint failed: categories\.name_key/),
    );
    expect(await row(handle, python.id)).toMatchObject({ name: 'Python' });
  });
});

describe('setCategoryArchived', () => {
  it('archives and unarchives idempotently and keeps assignments', async () => {
    const handle = getHandle();
    await seedPredefinedCategories(handle.db);
    const { artifactId } = await importArtifactVersion(handle, artifactInput('v1'));
    await assignCategoriesBySlug(handle.db, artifactId, ['python']);
    const id = await categoryId(handle, 'python');
    const python = { id, slug: 'python', name: 'Python' };

    expect(await setCategoryArchived(handle, { id, state: 'archived' })).toEqual({
      status: 'archived',
      category: { ...python, archived: true },
    });
    const archivedAt = (await row(handle, id))?.archivedAt;
    expect(archivedAt).toEqual(expect.any(String));
    expect(await setCategoryArchived(handle, { id, state: 'archived' })).toEqual({
      status: 'already-archived',
      category: { ...python, archived: true },
    });
    expect((await row(handle, id))?.archivedAt).toBe(archivedAt);
    expect(await getCategoryBySlug(handle.db, 'python')).toMatchObject({
      archived: true,
      artifactCount: 1,
    });

    expect(await setCategoryArchived(handle, { id, state: 'active' })).toEqual({
      status: 'unarchived',
      category: { ...python, archived: false },
    });
    expect(await setCategoryArchived(handle, { id, state: 'active' })).toEqual({
      status: 'already-active',
      category: { ...python, archived: false },
    });
    expect(await getCategoryBySlug(handle.db, 'python')).toMatchObject({
      archived: false,
      artifactCount: 1,
    });
  });

  it('reports a category that does not exist', async () => {
    const handle = getHandle();
    for (const state of ['archived', 'active'] as const) {
      expect(await setCategoryArchived(handle, { id: 'cat_missing', state })).toEqual({
        status: 'not-found',
      });
    }
  });

  it('maps an unarchive violation the check missed to name-taken, and rethrows one it cannot explain', async () => {
    const handle = getHandle();
    const greek = await created(handle, 'Ελληνικά');
    await setCategoryArchived(handle, { id: greek.id, state: 'archived' });
    const active = await created(handle, 'ΕΛΛΗΝΙΚΆ');
    expect(
      await withMissedCheck(handle, NAME_KEY_LOOKUP, (h) =>
        setCategoryArchived(h, {
          id: greek.id,
          state: 'active',
        }),
      ),
    ).toEqual({ status: 'name-taken', existing: active });

    const ruby = await created(handle, 'Ruby');
    await setCategoryArchived(handle, { id: ruby.id, state: 'archived' });
    handle.sqlite.exec(`
      create trigger clash before update on categories
        when old.name = 'Ruby' and new.archived_at is null begin
        insert into categories (id, slug, name, name_key, created_at, updated_at)
          values ('cat_ghost', 'ghost', 'ghost', 'ruby', 't', 't');
      end;
    `);
    await expect(
      setCategoryArchived(handle, { id: ruby.id, state: 'active' }),
    ).rejects.toHaveProperty(
      'cause.message',
      expect.stringMatching(/UNIQUE constraint failed: categories\.name_key/),
    );
    expect(await row(handle, ruby.id)).toMatchObject({ archivedAt: expect.any(String) });
  });
});

describe('getCategoryBySlug', () => {
  it('returns details and the artifact count, or null for an unknown slug', async () => {
    const handle = getHandle();
    const estimation = await created(handle, 'Estimation', 'Sizing work');
    expect(await getCategoryBySlug(handle.db, 'estimation')).toEqual({
      ...estimation,
      description: 'Sizing work',
      predefined: false,
      artifactCount: 0,
    });
    expect(await getCategoryBySlug(handle.db, 'missing')).toBeNull();
  });
});
