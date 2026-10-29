import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { highlightSamples } from '../components/output-files/highlight-fixtures';
import {
  highlightLines,
  languageForPath,
  SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS,
  SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT,
  type HighlightOptions,
  type HighlightResult,
} from '../lib/syntax-highlight';

// The Storybook stories of FileView and SideBySideDiff show precomputed tokens (stories cannot
// run server-only code). This test keeps those tokens equal to what lib/syntax-highlight.ts
// produces now; UPDATE_HIGHLIGHT_FIXTURES=1 rewrites the file instead.
//
// The fixtures are computed without Shiki's per-line time limit. That limit is cooperative and
// counts the lazy compilation of a grammar's regular expressions, so on a slow CI runner it cut
// the first line of the PHP sample ("<?php" as one token instead of "<?" and "php", PR #155),
// and the fixtures depended on the machine's speed.
const fixturePath = join(
  import.meta.dirname,
  '..',
  'components',
  'output-files',
  'highlight-fixtures.json',
);

async function computeFixtures(
  options: HighlightOptions,
): Promise<Record<string, HighlightResult>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(highlightSamples).map(async ([name, { path, text }]) => [
        name,
        await highlightLines(text, languageForPath(path), options),
      ]),
    ),
  );
}

// Highlighting all samples took 4.8 s on two loaded cores (vitest's default is 5 s): the first
// call creates the highlighter and compiles every grammar it touches (lesson 2026-10-21).
const FIXTURE_TEST_TIMEOUT_MS = 60_000;

const deterministic = { lineTimeLimitMs: SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT };
const committed = () =>
  JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, HighlightResult>;

describe('Storybook highlight fixtures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'match the highlighter output',
    async () => {
      const computed = await computeFixtures(deterministic);
      if (process.env.UPDATE_HIGHLIGHT_FIXTURES === '1') {
        writeFileSync(fixturePath, `${JSON.stringify(computed, null, 2)}\n`);
      }
      expect(committed()).toEqual(computed);
      expect(Object.values(computed).every((result) => result.kind === 'highlighted')).toBe(true);
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  // Regression for PR #155's CI failure: a clock that advances a second per read stands in for
  // a runner too slow for the time limit. vscode-textmate reads Date.now() to enforce it.
  it(
    'do not depend on the speed of the machine',
    async () => {
      let now = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));

      const limited = await computeFixtures({
        lineTimeLimitMs: SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS,
      });
      expect(limited).not.toEqual(committed());

      expect(await computeFixtures(deterministic)).toEqual(committed());
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );
});
