import { describe, expect, it } from 'vitest';
import { slugify } from '../src/artifacts';
import {
  CATEGORY_DESCRIPTION_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_SLUG_MAX_LENGTH,
  PREDEFINED_CATEGORIES,
  categoryNameKey,
  categorySlug,
  normalizeCategoryName,
} from '../src/categories';
import { modelSelectionSchema } from '../src/models';

describe('PREDEFINED_CATEGORIES', () => {
  it('has unique, URL-safe slugs and non-empty names and descriptions', () => {
    const slugs = PREDEFINED_CATEGORIES.map((category) => category.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const category of PREDEFINED_CATEGORIES) {
      expect(slugify(category.slug)).toBe(category.slug);
      expect(category.name.trim()).not.toBe('');
      expect(category.description.trim()).not.toBe('');
    }
  });
});

describe('category limits', () => {
  it('names the limits SPEC-124 FR-124-03 sets', () => {
    expect([
      CATEGORY_NAME_MAX_LENGTH,
      CATEGORY_DESCRIPTION_MAX_LENGTH,
      CATEGORY_SLUG_MAX_LENGTH,
    ]).toEqual([64, 500, 64]);
  });
});

describe('normalizeCategoryName', () => {
  it('trims, collapses whitespace runs to one space and composes to NFC', () => {
    expect(normalizeCategoryName('  Client \t\n  A  ')).toBe('Client A');
    expect(normalizeCategoryName('a\u00a0\u2003b')).toBe('a b');
    // "e" + combining acute (NFD) becomes the single precomposed "é".
    expect(normalizeCategoryName('Cafe\u0301')).toBe('Caf\u00e9');
    expect(normalizeCategoryName('   ')).toBe('');
  });
});

describe('categoryNameKey', () => {
  it('folds case in full Unicode but keeps accents', () => {
    expect(categoryNameKey(' TESTING ')).toBe('testing');
    expect(categoryNameKey('testing')).toBe(categoryNameKey('Testing'));
    expect(categoryNameKey('Ärger')).toBe(categoryNameKey('ärger'));
    expect(categoryNameKey('Café')).not.toBe(categoryNameKey('Cafe'));
    expect(categoryNameKey('Cafe\u0301  Bar')).toBe('caf\u00e9 bar');
  });
});

describe('categorySlug', () => {
  it('derives the slugify shape from Latin letters and digits', () => {
    expect(categorySlug('CI and Ops')).toBe('ci-and-ops');
    expect(categorySlug('Café')).toBe('cafe');
    expect(categorySlug('C#')).toBe('c');
    expect(categorySlug('日本語 2')).toBe('2');
    expect(categorySlug('Item')).toBe('item');
  });

  it('returns null, not the slugify fallback, for a name without a Latin letter or digit', () => {
    expect(categorySlug('日本語')).toBeNull();
    expect(categorySlug('!!!')).toBeNull();
    expect(categorySlug('')).toBeNull();
    expect(slugify('日本語')).toBe('item');
  });

  it('cuts at 64 characters and drops the trailing hyphen the cut leaves', () => {
    const name = `${'a'.repeat(63)} b`;
    expect(slugify(name)).toHaveLength(65);
    expect(categorySlug(name)).toBe('a'.repeat(63));
    expect(categorySlug('x'.repeat(100))).toBe('x'.repeat(CATEGORY_SLUG_MAX_LENGTH));
    expect(categorySlug(`Category ${'9'.repeat(55)}`)).toBe(`category-${'9'.repeat(55)}`);
    expect(categorySlug(`Category ${'9'.repeat(55)}`)).toHaveLength(64);
  });
});

describe('modelSelectionSchema', () => {
  it('accepts a provider and model', () => {
    expect(modelSelectionSchema.parse({ provider: 'anthropic', model: 'claude-x' })).toEqual({
      provider: 'anthropic',
      model: 'claude-x',
    });
  });

  it.each([
    [{ provider: '', model: 'm' }],
    [{ provider: 'p' }],
    [{ provider: 'p', model: 'm', harness: 'claude-code' }],
  ])('rejects %j', (input) => {
    expect(modelSelectionSchema.safeParse(input).success).toBe(false);
  });
});
