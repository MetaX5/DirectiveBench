import { describe, expect, it } from 'vitest';
import { suiteOptions, suiteSubject } from '../lib/artifact-metadata';

describe('suiteSubject (issue 219)', () => {
  it('names a suite by its name and definition ID, after a comma', () => {
    expect(
      suiteSubject({ name: 'Input validation (mock agent demo)', slug: 'mock-input-validation' }),
    ).toBe('Input validation (mock agent demo), ID mock-input-validation');
  });
});

describe('suiteOptions (issue 235, decision L1)', () => {
  it('adds the ID to every suite whose name another suite in the database has', () => {
    // "Safety" (safety-b) alone in the picker: its twin is assigned, so not listed here, but the
    // database-wide flag still says the name is shared.
    expect(
      suiteOptions([
        { id: 'suite_b', slug: 'safety-b', name: 'Safety', nameShared: true },
        { id: 'suite_c', slug: 'style', name: 'Style', nameShared: false },
      ]),
    ).toEqual([
      { id: 'suite_b', label: 'Safety, ID safety-b' },
      { id: 'suite_c', label: 'Style' },
    ]);
  });

  it('lists names alone when no other suite has them', () => {
    expect(
      suiteOptions([
        { id: 'suite_a', slug: 'safety', name: 'Safety', nameShared: false },
        { id: 'suite_b', slug: 'style', name: 'Style', nameShared: false },
      ]),
    ).toEqual([
      { id: 'suite_a', label: 'Safety' },
      { id: 'suite_b', label: 'Style' },
    ]);
    expect(suiteOptions([])).toEqual([]);
  });
});
