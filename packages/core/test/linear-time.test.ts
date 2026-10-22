import { describe, expect, it } from 'vitest';
import {
  expectLinearTime,
  LINEAR_TIME_TEST_TIMEOUT_MS,
  linearTimeRatio,
  MAX_LINEAR_RATIO,
  textBaseline,
} from '../../../test-support/linear-time';

// The shared linear-time helper (test-support/linear-time.ts) is test code imported by every
// package; it is checked here, in the package at the root of the dependency graph.

/** Linear: one pass over the text. */
function countSpaces(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 32) count += 1;
  }
  return count;
}

/** N^1.5: one pass per √length, like a search repeated for every distinct run length. */
function countSpacesRepeatedly(text: string): number {
  let count = 0;
  const passes = Math.floor(Math.sqrt(text.length));
  for (let pass = 0; pass < passes; pass += 1) count += countSpaces(text);
  return count;
}

/** Quadratic: rescans the rest of the text from every space, like an unbounded lookahead. */
function countSpacePairs(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 32) continue;
    for (let next = index + 1; next < text.length; next += 1) {
      if (text.charCodeAt(next) === 32) count += 1;
    }
  }
  return count;
}

const words = (size: number) => 'word '.repeat(size / 5);

describe('expectLinearTime', () => {
  it(
    'passes linear code',
    async () => {
      await expectLinearTime({
        build: words,
        run: countSpaces,
        baseline: textBaseline,
        size: 800_000,
      });
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );

  it(
    'fails N^1.5 code',
    async () => {
      const superlinear = {
        build: words,
        run: countSpacesRepeatedly,
        baseline: textBaseline,
        size: 32_000,
      };
      expect(await linearTimeRatio(superlinear)).toBeGreaterThan(MAX_LINEAR_RATIO);
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );

  it(
    'fails quadratic code',
    async () => {
      const quadratic = {
        build: words,
        run: countSpacePairs,
        baseline: textBaseline,
        size: 16_000,
      };
      expect(await linearTimeRatio(quadratic)).toBeGreaterThan(MAX_LINEAR_RATIO);
      await expect(expectLinearTime(quadratic, 'quadratic')).rejects.toThrow(/quadratic/);
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );

  it(
    'measures asynchronous code',
    async () => {
      const run = async (text: string) => countSpaces(text);
      await expectLinearTime({ build: words, run, baseline: textBaseline, size: 800_000 });
    },
    LINEAR_TIME_TEST_TIMEOUT_MS,
  );
});
