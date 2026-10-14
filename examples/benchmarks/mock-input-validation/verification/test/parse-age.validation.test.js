import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAge } from '../src/parse-age.js';

test('rejects non-numeric input', () => {
  assert.throws(() => parseAge('abc'), RangeError);
  assert.throws(() => parseAge(''), RangeError);
});

test('rejects partially numeric input', () => {
  assert.throws(() => parseAge('42abc'), RangeError);
  assert.throws(() => parseAge('4.5'), RangeError);
});

test('rejects out-of-range ages', () => {
  assert.throws(() => parseAge('-1'), RangeError);
  assert.throws(() => parseAge('151'), RangeError);
});
