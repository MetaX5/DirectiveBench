import { describe, expect, it } from 'vitest';
import { suiteOptions, suiteSubject } from '../lib/artifact-metadata';

describe('suiteSubject (issue 219)', () => {
  it('names a suite by its name and definition ID, after a comma', () => {
    expect(
      suiteSubject({ name: 'Input validation (mock agent demo)', slug: 'mock-input-validation' }),
    ).toBe('Input validation (mock agent demo), ID mock-input-validation');
  });
});

describe('suiteOptions (issue 219, decision I2)', () => {
  it('adds the ID only to suites whose name another listed suite shares', () => {
    expect(
      suiteOptions([
        { id: 'suite_a', slug: 'safety-a', name: 'Safety' },
        { id: 'suite_b', slug: 'style', name: 'Style' },
        { id: 'suite_c', slug: 'safety-b', name: 'Safety' },
      ]),
    ).toEqual([
      { id: 'suite_a', label: 'Safety, ID safety-a' },
      { id: 'suite_b', label: 'Style' },
      { id: 'suite_c', label: 'Safety, ID safety-b' },
    ]);
  });

  it('lists names alone when they are all different', () => {
    expect(
      suiteOptions([
        { id: 'suite_a', slug: 'safety', name: 'Safety' },
        { id: 'suite_b', slug: 'style', name: 'Style' },
      ]),
    ).toEqual([
      { id: 'suite_a', label: 'Safety' },
      { id: 'suite_b', label: 'Style' },
    ]);
    expect(suiteOptions([])).toEqual([]);
  });
});
