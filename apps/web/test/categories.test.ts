import { idListFingerprint } from '@directivebench/core';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_GONE_MESSAGE, INCOMPLETE_FORM_MESSAGE } from '../lib/artifact-metadata';
import {
  CATEGORY_GONE_MESSAGE,
  archiveCategorySchema,
  archiveCategoryState,
  archiveReason,
  archivedStatusText,
  artifactCategorySchema,
  artifactsPhrase,
  assignCategoryState,
  bulkCategoryModel,
  bulkCategoryState,
  categoriesCardModel,
  categoryChipLabel,
  categorySubject,
  categoryDescriptionSchema,
  categoryFilterOptions,
  categoryNameSchema,
  categoryRefused,
  createCategorySchema,
  createCategoryState,
  parseBulkCategoryForm,
  unassignCategoryState,
  updateCategorySchema,
  updateCategoryState,
} from '../lib/categories';

const values = { name: 'Testing', description: 'Kept' };
const python = { id: 'cat_py', slug: 'python', name: 'Python', archived: false };

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues.map((issue) => issue.message);
}

describe('categoryNameSchema (SPEC-124 §8.3, §13)', () => {
  it('normalises the name: NFC, trimmed, whitespace runs collapsed', () => {
    expect(categoryNameSchema.parse('  CI   and Ops ')).toBe('CI and Ops');
    expect(categoryNameSchema.parse('Café')).toBe('Café');
    // No Latin letter or digit is still a name (A5): the repository generates its slug.
    expect(categoryNameSchema.parse('日本語')).toBe('日本語');
    expect(categoryNameSchema.parse('!!!')).toBe('!!!');
  });

  it('refuses control characters on the raw input, before normalisation turns them into spaces', () => {
    for (const raw of ['CI\nOps', 'CI\tOps', 'CI\r\nOps', 'Bell\u0007', '\n']) {
      expect(messages(categoryNameSchema.safeParse(raw)), JSON.stringify(raw)).toEqual([
        'A name cannot contain line breaks or other control characters.',
      ]);
    }
  });

  it('refuses an empty name and one over 64 characters after normalisation', () => {
    expect(messages(categoryNameSchema.safeParse(''))).toEqual(['Enter a name.']);
    expect(messages(categoryNameSchema.safeParse('    '))).toEqual(['Enter a name.']);
    expect(messages(categoryNameSchema.safeParse('x'.repeat(65)))).toEqual([
      'A name can be at most 64 characters. Shorten it.',
    ]);
    expect(categoryNameSchema.parse(` ${'x'.repeat(64)} `)).toBe('x'.repeat(64));
  });
});

describe('categoryDescriptionSchema', () => {
  it('trims, keeps up to 500 characters and turns an empty description into null', () => {
    expect(categoryDescriptionSchema.parse('  Pipelines ')).toBe('Pipelines');
    expect(categoryDescriptionSchema.parse('   ')).toBeNull();
    expect(categoryDescriptionSchema.parse('')).toBeNull();
    expect(categoryDescriptionSchema.parse('x'.repeat(500))).toBe('x'.repeat(500));
  });

  it('refuses over 500 characters and control characters', () => {
    expect(messages(categoryDescriptionSchema.safeParse('x'.repeat(501)))).toEqual([
      'A description can be at most 500 characters. Shorten it.',
    ]);
    expect(messages(categoryDescriptionSchema.safeParse('one\ttwo'))).toEqual([
      'A description cannot contain line breaks or other control characters.',
    ]);
  });
});

describe('form schemas', () => {
  it('parse the create, update and archive forms', () => {
    expect(createCategorySchema.parse({ name: 'Estimation', description: '' })).toEqual({
      name: 'Estimation',
      description: null,
    });
    expect(updateCategorySchema.parse({ id: 'cat_1', name: 'A', description: 'B' })).toEqual({
      id: 'cat_1',
      name: 'A',
      description: 'B',
    });
    expect(archiveCategorySchema.parse({ id: 'cat_1', intent: 'archive' })).toEqual({
      id: 'cat_1',
      state: 'archived',
    });
    expect(archiveCategorySchema.parse({ id: 'cat_1', intent: 'unarchive' })).toEqual({
      id: 'cat_1',
      state: 'active',
    });
    expect(archiveCategorySchema.safeParse({ id: 'cat_1', intent: 'delete' }).success).toBe(false);
    expect(archiveCategorySchema.safeParse({ id: '', intent: 'archive' }).success).toBe(false);
  });
});

describe('categoryRefused', () => {
  it('marks the first field with an issue and keeps both entered values', () => {
    const name = createCategorySchema.safeParse({ name: '', description: 'x'.repeat(501) });
    expect(categoryRefused(name.error!, values)).toEqual({
      kind: 'fieldError',
      message: 'Enter a name.',
      field: 'name',
      values,
    });
    const description = createCategorySchema.safeParse({ name: 'A', description: 'a\u0000' });
    expect(categoryRefused(description.error!, values)).toEqual({
      kind: 'fieldError',
      message: 'A description cannot contain line breaks or other control characters.',
      field: 'description',
      values,
    });
  });

  it('turns a missing field or a forged hidden id into a general error', () => {
    for (const input of [
      { id: '', name: 'A', description: '' },
      { id: '', name: '', description: '' },
      { id: 'cat_1', name: null, description: '' },
      { id: 'cat_1', name: 'A', description: null },
    ]) {
      const result = updateCategorySchema.safeParse(input);
      expect(categoryRefused(result.error!, values), JSON.stringify(input)).toEqual({
        kind: 'error',
        message: INCOMPLETE_FORM_MESSAGE,
      });
    }
  });
});

describe('artifactsPhrase', () => {
  it('uses the singular for one and groups thousands', () => {
    expect(artifactsPhrase(0)).toBe('0 artifacts');
    expect(artifactsPhrase(1)).toBe('1 artifact');
    expect(artifactsPhrase(1240)).toBe('1,240 artifacts');
  });
});

describe('createCategoryState (§13, D15)', () => {
  it('maps every outcome', () => {
    expect(
      createCategoryState(
        { status: 'created', category: { ...python, name: 'Estimation' } },
        values,
      ),
    ).toEqual({ kind: 'success', message: 'Created Estimation.' });
    expect(
      createCategoryState(
        { status: 'name-taken', existing: { ...python, name: 'Testing' } },
        values,
      ),
    ).toEqual({
      kind: 'fieldError',
      message: 'A category named Testing already exists. Choose another name.',
      field: 'name',
      values,
    });
    expect(
      createCategoryState(
        { status: 'slug-taken', existing: { ...python, slug: 'testing', name: 'Testing' } },
        values,
      ),
    ).toEqual({
      kind: 'fieldError',
      message: 'The name gives the link testing, which Testing already uses. Choose another name.',
      field: 'name',
      values,
    });
    expect(
      createCategoryState(
        { status: 'slug-taken', existing: { ...python, archived: true } },
        values,
      ),
    ).toEqual({
      kind: 'fieldError',
      message:
        'The archived category Python already uses the link python. Unarchive it on its page instead.',
      field: 'name',
      values,
    });
  });
});

describe('updateCategoryState (FR-124-07, D15)', () => {
  it('maps every outcome', () => {
    const devops = { id: 'cat_d', slug: 'devops', name: 'CI and Ops', archived: false };
    expect(
      updateCategoryState({ status: 'updated', category: devops, previousName: 'DevOps' }, values),
    ).toEqual({
      kind: 'success',
      message: 'Renamed to CI and Ops. Its slug stays devops, so links keep working.',
    });
    expect(
      updateCategoryState(
        { status: 'updated', category: devops, previousName: 'CI and Ops' },
        values,
      ),
    ).toEqual({ kind: 'success', message: 'Saved.' });
    expect(updateCategoryState({ status: 'unchanged', category: devops }, values)).toEqual({
      kind: 'success',
      message: 'Nothing changed.',
    });
    expect(
      updateCategoryState(
        { status: 'name-taken', existing: { ...python, name: 'Testing' } },
        values,
      ),
    ).toEqual({
      kind: 'fieldError',
      message: 'A category named Testing already exists. Choose another name.',
      field: 'name',
      values,
    });
    expect(updateCategoryState({ status: 'not-found' }, values)).toEqual({
      kind: 'error',
      message: CATEGORY_GONE_MESSAGE,
    });
  });
});

describe('archiveCategoryState (FR-124-08, FR-124-09, D15)', () => {
  it('maps every outcome, with the artifact count on archive', () => {
    const archived = { status: 'archived', category: { ...python, archived: true } } as const;
    expect(archiveCategoryState(archived, 2)).toEqual({
      kind: 'success',
      message: 'Archived Python. It stays on 2 artifacts.',
    });
    expect(archiveCategoryState(archived, 1)).toEqual({
      kind: 'success',
      message: 'Archived Python. It stays on 1 artifact.',
    });
    expect(archiveCategoryState(archived, 1240)).toEqual({
      kind: 'success',
      message: 'Archived Python. It stays on 1,240 artifacts.',
    });
    expect(archiveCategoryState(archived, 0)).toEqual({
      kind: 'success',
      message: 'Archived Python.',
    });
    expect(archiveCategoryState({ status: 'already-archived', category: python }, 0)).toEqual({
      kind: 'success',
      message: 'Python is already archived.',
    });
    expect(archiveCategoryState({ status: 'unarchived', category: python }, 0)).toEqual({
      kind: 'success',
      message: 'Unarchived Python. It is back in pickers and filters.',
    });
    expect(archiveCategoryState({ status: 'already-active', category: python }, 0)).toEqual({
      kind: 'success',
      message: 'Python is already active.',
    });
    expect(archiveCategoryState({ status: 'name-taken', existing: python }, 0)).toEqual({
      kind: 'error',
      message: 'An active category is already named Python. Rename one of them first.',
    });
    expect(archiveCategoryState({ status: 'not-found' }, 0)).toEqual({
      kind: 'error',
      message: CATEGORY_GONE_MESSAGE,
    });
  });
});

describe('archive panel and status copy (§11, D15)', () => {
  it('names the artifact count, singular for one and a fixed sentence for none', () => {
    expect(archiveReason(1240)).toBe(
      'It leaves pickers, filters and the bulk form. It stays on 1,240 artifacts, shown as archived.',
    );
    expect(archiveReason(1)).toBe(
      'It leaves pickers, filters and the bulk form. It stays on 1 artifact, shown as archived.',
    );
    expect(archiveReason(0)).toBe(
      'It leaves pickers, filters and the bulk form. No artifact has it.',
    );
    expect(archivedStatusText(2)).toBe('Archived. It stays on 2 artifacts.');
    expect(archivedStatusText(1)).toBe('Archived. It stays on 1 artifact.');
    expect(archivedStatusText(0)).toBe('Archived. No artifact has it.');
  });
});

describe('categoryChipLabel (FR-124-14)', () => {
  it('marks archived categories', () => {
    expect(categoryChipLabel({ name: 'Python', archived: true })).toBe('Python (archived)');
    expect(categoryChipLabel({ name: 'Testing', archived: false })).toBe('Testing');
  });
});

describe('categorySubject (issue 220, D4, D17)', () => {
  it('names a category by its chip text and slug, after a comma', () => {
    expect(categorySubject({ name: 'Platform', slug: 'platform', archived: true })).toBe(
      'Platform (archived), slug platform',
    );
    expect(categorySubject({ name: 'Code Quality', slug: 'code-quality', archived: false })).toBe(
      'Code Quality, slug code-quality',
    );
  });
});

describe('categoryFilterOptions (FR-124-15, D12)', () => {
  const categories = [
    { slug: 'devops', name: 'CI and Ops', archivedAt: null },
    { slug: 'python', name: 'Python', archivedAt: '2026-11-05T00:00:00.000Z' },
    { slug: 'testing', name: 'Testing', archivedAt: null },
  ];

  it('lists active categories only, unless the selected one is archived: then it comes last', () => {
    const active = [
      { value: 'devops', label: 'CI and Ops' },
      { value: 'testing', label: 'Testing' },
    ];
    expect(categoryFilterOptions(categories, undefined)).toEqual(active);
    expect(categoryFilterOptions(categories, 'testing')).toEqual(active);
    expect(categoryFilterOptions(categories, 'unknown')).toEqual(active);
    expect(categoryFilterOptions(categories, 'python')).toEqual([
      ...active,
      { value: 'python', label: 'Python (archived)' },
    ]);
  });
});

describe('artifactCategorySchema (§8.3, Phase 3)', () => {
  it('needs both ids', () => {
    expect(artifactCategorySchema.parse({ artifactId: 'art_1', categoryId: 'cat_1' })).toEqual({
      artifactId: 'art_1',
      categoryId: 'cat_1',
    });
    for (const input of [
      { artifactId: 'art_1', categoryId: '' },
      { artifactId: '', categoryId: 'cat_1' },
      { artifactId: 'art_1', categoryId: null },
      { categoryId: 'cat_1' },
    ]) {
      expect(artifactCategorySchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe('assignCategoryState (FR-124-11, §13, D24)', () => {
  it('maps every outcome; already assigned is a status, not an error', () => {
    expect(assignCategoryState({ status: 'assigned', category: python })).toEqual({
      kind: 'success',
      message: 'Assigned Python.',
    });
    expect(assignCategoryState({ status: 'already-assigned', category: python })).toEqual({
      kind: 'success',
      message: 'Python is already assigned.',
    });
    expect(
      assignCategoryState({ status: 'category-archived', category: { ...python, archived: true } }),
    ).toEqual({
      kind: 'error',
      message: 'Python is archived. Unarchive it on its page before assigning it.',
    });
    expect(assignCategoryState({ status: 'category-not-found' })).toEqual({
      kind: 'error',
      message: CATEGORY_GONE_MESSAGE,
    });
    expect(assignCategoryState({ status: 'artifact-not-found' })).toEqual({
      kind: 'error',
      message: ARTIFACT_GONE_MESSAGE,
    });
  });
});

describe('unassignCategoryState (FR-124-12, D23, D24)', () => {
  it('maps every outcome; an archived removal says how to assign it again', () => {
    expect(unassignCategoryState({ status: 'removed', category: python })).toEqual({
      kind: 'success',
      message: 'Removed Python.',
    });
    expect(
      unassignCategoryState({ status: 'removed', category: { ...python, archived: true } }),
    ).toEqual({
      kind: 'success',
      message: 'Removed Python. To assign it again, unarchive it on its page first.',
    });
    expect(unassignCategoryState({ status: 'not-assigned', category: python })).toEqual({
      kind: 'success',
      message: 'Python was already removed.',
    });
    expect(unassignCategoryState({ status: 'category-not-found' })).toEqual({
      kind: 'error',
      message: CATEGORY_GONE_MESSAGE,
    });
    expect(unassignCategoryState({ status: 'artifact-not-found' })).toEqual({
      kind: 'error',
      message: ARTIFACT_GONE_MESSAGE,
    });
  });
});

describe('categoriesCardModel (§11, D20 to D22)', () => {
  const all = [
    { id: 'cat_doc', name: 'Documentation' },
    { id: 'cat_test', name: 'Testing' },
  ];
  const testing = { id: 'cat_test', slug: 'testing', name: 'Testing', archived: false };
  const archivedPython = { ...python, archived: true };

  it('labels the chips and offers the active, unassigned categories in the given order', () => {
    expect(categoriesCardModel([testing, archivedPython], all)).toEqual({
      chips: [
        {
          id: 'cat_test',
          label: 'Testing',
          archived: false,
          removeName: 'Remove category Testing, slug testing',
        },
        {
          id: 'cat_py',
          label: 'Python (archived)',
          archived: true,
          removeName: 'Remove category Python (archived), slug python',
        },
      ],
      available: [{ id: 'cat_doc', name: 'Documentation' }],
      noPicker: null,
    });
  });

  it('gives two archived chips with one name different Remove names (issue 220)', () => {
    const platform = { id: 'cat_p1', slug: 'platform', name: 'Platform', archived: true };
    const platform2 = { id: 'cat_p2', slug: 'platform-2', name: 'Platform', archived: true };
    const { chips } = categoriesCardModel([platform, platform2], []);
    expect(chips.map((c) => c.label)).toEqual(['Platform (archived)', 'Platform (archived)']);
    expect(chips.map((c) => c.removeName)).toEqual([
      'Remove category Platform (archived), slug platform',
      'Remove category Platform (archived), slug platform-2',
    ]);
  });

  it('replaces the picker when every active category is assigned (D21)', () => {
    const documentation = { id: 'cat_doc', slug: 'documentation', name: 'Documentation' };
    const model = categoriesCardModel([{ ...documentation, archived: false }, testing], all);
    expect(model.available).toEqual([]);
    expect(model.noPicker).toBe('all-assigned');
  });

  it('replaces the picker when no active category exists (D22)', () => {
    expect(categoriesCardModel([archivedPython], [])).toMatchObject({
      available: [],
      noPicker: 'none-active',
    });
    expect(categoriesCardModel([], [])).toEqual({
      chips: [],
      available: [],
      noPicker: 'none-active',
    });
  });
});

describe('bulk category form (SPEC-124 Phase 4, §8.3, §11.4)', () => {
  const fingerprint = 'a'.repeat(64);
  function bulkForm(fields: Record<string, string | string[]>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      for (const one of [value].flat()) data.append(name, one);
    }
    return data;
  }
  const valid = {
    categoryId: 'cat_a',
    mode: 'assign',
    listFingerprint: fingerprint,
    q: 'client',
    type: '',
    category: '',
    repository: 'repo_x',
  };

  it('parses the fields and the posted filters', () => {
    expect(parseBulkCategoryForm(bulkForm(valid))).toEqual({
      categoryId: 'cat_a',
      mode: 'assign',
      listFingerprint: fingerprint,
      filter: { q: 'client', repository: 'repo_x' },
    });
    expect(parseBulkCategoryForm(bulkForm({ ...valid, mode: 'remove' }))?.mode).toBe('remove');
  });

  it('refuses a missing or forged field and an invalid or repeated filter', () => {
    const forged: Record<string, string | string[]>[] = [
      { ...valid, categoryId: '' },
      { ...valid, mode: 'toggle' },
      { ...valid, listFingerprint: 'A'.repeat(64) },
      { ...valid, listFingerprint: 'a'.repeat(63) },
      { ...valid, type: 'script' },
      { ...valid, category: 'Not A Slug' },
      { ...valid, repository: 'elsewhere' },
      { ...valid, q: 'x'.repeat(201) },
      { ...valid, q: ['a', 'b'] },
    ];
    for (const fields of forged) expect(parseBulkCategoryForm(bulkForm(fields))).toBeNull();
    const { mode: _mode, ...noMode } = valid;
    expect(parseBulkCategoryForm(bulkForm(noMode))).toBeNull();
  });

  const clientA = { id: 'cat_a', slug: 'client-a', name: 'Client A', archived: false };
  const done = (changed: number, unchanged: number) =>
    ({ status: 'done', changed, unchanged, category: clientA }) as const;

  it('words every assign result, with singular and thousands forms (D34)', () => {
    const cases: Array<[number, number, string]> = [
      [14, 0, 'Assigned Client A to 14 artifacts.'],
      [1, 0, 'Assigned Client A to 1 artifact.'],
      [11, 3, 'Assigned Client A to 11 artifacts. 3 already had it.'],
      [1_239, 1, 'Assigned Client A to 1,239 artifacts. 1 already had it.'],
      [0, 14, 'All 14 listed artifacts already had Client A.'],
      [0, 1_240, 'All 1,240 listed artifacts already had Client A.'],
      [0, 1, 'The listed artifact already had Client A.'],
    ];
    for (const [changed, unchanged, message] of cases) {
      expect(bulkCategoryState(done(changed, unchanged), 'assign')).toEqual({
        kind: 'success',
        message,
      });
    }
  });

  it('words every remove result (D34)', () => {
    const cases: Array<[number, number, string]> = [
      [14, 0, 'Removed Client A from 14 artifacts.'],
      [1, 0, 'Removed Client A from 1 artifact.'],
      [11, 3, 'Removed Client A from 11 artifacts. 3 did not have it.'],
      [11, 1, 'Removed Client A from 11 artifacts. 1 did not have it.'],
      [0, 14, 'None of the 14 listed artifacts had Client A.'],
      [0, 1, 'The listed artifact did not have Client A.'],
    ];
    for (const [changed, unchanged, message] of cases) {
      expect(bulkCategoryState(done(changed, unchanged), 'remove')).toEqual({
        kind: 'success',
        message,
      });
    }
  });

  it('words every refusal (§13)', () => {
    const changed = (actualCount: number) =>
      bulkCategoryState({ status: 'list-changed', actualCount }, 'assign').message;
    expect(changed(13)).toBe(
      'The list changed since the page loaded (now 13 artifacts). Check it and try again.',
    );
    expect(changed(1)).toBe(
      'The list changed since the page loaded (now 1 artifact). Check it and try again.',
    );
    expect(changed(0)).toBe(
      'The list changed since the page loaded (now no artifacts). Check it and try again.',
    );
    expect(changed(12_400)).toContain('(now 12,400 artifacts)');
    const archived = {
      status: 'category-archived',
      category: { ...python, archived: true },
    } as const;
    expect(bulkCategoryState(archived, 'assign')).toEqual({
      kind: 'error',
      message: 'Python is archived. Unarchive it on its page before assigning it.',
    });
    expect(bulkCategoryState(archived, 'remove')).toEqual({
      kind: 'error',
      message: 'Python is archived. Unarchive it on its page before removing it from a list.',
    });
    expect(bulkCategoryState({ status: 'category-not-found' }, 'remove')).toEqual({
      kind: 'error',
      message: CATEGORY_GONE_MESSAGE,
    });
    expect(
      bulkCategoryState({ status: 'too-many', actualCount: 12_400, limit: 10_000 }, 'assign'),
    ).toEqual({
      kind: 'error',
      message: 'This list has 12,400 artifacts. Narrow the filters to at most 10,000.',
    });
  });

  const active = [{ id: 'cat_a', name: 'Client A' }];
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `art_${i}`);

  it('decides the D28 state in order: empty, ignored URL value, over the limit, no active category', () => {
    const state = (n: number, invalid: string[], categories = active) =>
      bulkCategoryModel({ listedIds: ids(n), filter: {}, invalid, active: categories }).state;
    expect(state(0, ['category'], [])).toBe('empty');
    expect(state(10_001, ['category'], [])).toBe('invalid-url');
    expect(state(10_001, [], [])).toBe('too-many');
    expect(state(10_000, [], [])).toBe('none-active');
    expect(state(10_000, [], active)).toBe('ready');
    expect(state(1, [], active)).toBe('ready');
  });

  it('derives the count, the fingerprint and the hidden fields from the listed ids it is given', () => {
    const listedIds = ['art_b', 'art_a'];
    const model = bulkCategoryModel({
      listedIds,
      filter: { type: 'skill' },
      invalid: [],
      active: [{ id: 'cat_a', name: 'Client A', extra: 1 } as { id: string; name: string }],
    });
    expect(model).toEqual({
      state: 'ready',
      categories: [{ id: 'cat_a', name: 'Client A' }],
      label: 'Category for the 2 listed artifacts',
      phrase: '2 artifacts',
      tooManyText: '',
      fields: [
        { name: 'q', value: '' },
        { name: 'type', value: 'skill' },
        { name: 'category', value: '' },
        { name: 'repository', value: '' },
      ],
      listFingerprint: idListFingerprint(listedIds),
      noFilter: false,
    });
    const one = bulkCategoryModel({ listedIds: ['art_a'], filter: {}, invalid: [], active });
    expect(one).toMatchObject({
      label: 'Category for the 1 listed artifact',
      phrase: '1 artifact',
      noFilter: true,
    });
    expect(
      bulkCategoryModel({ listedIds: ids(12_400), filter: {}, invalid: [], active }),
    ).toMatchObject({
      label: 'Category for the 12,400 listed artifacts',
      tooManyText:
        'This list has 12,400 artifacts. To change a category for all of them, narrow the filters to at most 10,000.',
    });
  });
});
