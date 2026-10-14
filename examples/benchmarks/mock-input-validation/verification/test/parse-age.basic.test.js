import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAge } from '../src/parse-age.js';

test('parses plain ages', () => {
  assert.equal(parseAge('42'), 42);
  assert.equal(parseAge('0'), 0);
});

test('tolerates surrounding whitespace', () => {
  assert.equal(parseAge(' 7 '), 7);
});
