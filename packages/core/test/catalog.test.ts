import { describe, expect, it } from 'vitest';
import { slugify } from '../src/artifacts';
import { PREDEFINED_CATEGORIES } from '../src/categories';
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
