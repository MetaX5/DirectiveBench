import { mkdtempSync, rmSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  describe('off the test thread', () => {
    const MiB = 1024 * 1024;
    const FILE_BYTES = 256 * MiB;
    const LARGE = 8 * MiB;
    const IOVECS = 256;
    const chunk = Buffer.alloc(MiB);
    let dir: string;
    let file: FileHandle;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'directivebench-linear-time-'));
      // Sparse: no disk space or write time, and reads are kernel copies of zeros.
      file = await open(join(dir, 'sparse'), 'w+');
      await file.truncate(FILE_BYTES);
    });

    afterAll(async () => {
      await file.close();
      rmSync(dir, { recursive: true, force: true });
    });

    /**
     * Reads `bytes` in one libuv request with a constant number of buffers, so the test thread's
     * work stays the same and the copying happens on the thread pool.
     */
    const read = (bytes: number) =>
      file.readv(
        Array.from({ length: IOVECS }, () => chunk.subarray(0, Math.floor(bytes / IOVECS))),
        0,
      );

    it(
      'fails superlinear work done on the thread pool (Codex review round 2 of PR #121)',
      async () => {
        // size² bytes against a baseline reading size bytes. With the test thread's clock this
        // measured 2.3, under the bound; asynchronous code is measured with the process clock.
        const offThread = {
          build: (size: number) => ({
            linear: size,
            quadratic: (size * size * FILE_BYTES) / LARGE ** 2,
          }),
          run: ({ quadratic }: { quadratic: number }) => read(quadratic),
          baseline: ({ linear }: { linear: number }) => read(linear),
          size: LARGE,
        };
        expect(await linearTimeRatio(offThread)).toBeGreaterThan(MAX_LINEAR_RATIO);
      },
      LINEAR_TIME_TEST_TIMEOUT_MS,
    );
  });
});
