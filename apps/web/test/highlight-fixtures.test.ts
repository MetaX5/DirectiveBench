import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { highlightSamples } from '../components/output-files/highlight-fixtures';
import { highlightLines, languageForPath, type HighlightResult } from '../lib/syntax-highlight';

// The Storybook stories of FileView and SideBySideDiff show precomputed tokens (stories cannot
// run server-only code). This test keeps those tokens equal to what lib/syntax-highlight.ts
// produces now; UPDATE_HIGHLIGHT_FIXTURES=1 rewrites the file instead.
const fixturePath = join(
  import.meta.dirname,
  '..',
  'components',
  'output-files',
  'highlight-fixtures.json',
);

describe('Storybook highlight fixtures', () => {
  it('match the highlighter output', async () => {
    const computed: Record<string, HighlightResult> = Object.fromEntries(
      await Promise.all(
        Object.entries(highlightSamples).map(async ([name, { path, text }]) => [
          name,
          await highlightLines(text, languageForPath(path)),
        ]),
      ),
    );
    if (process.env.UPDATE_HIGHLIGHT_FIXTURES === '1') {
      writeFileSync(fixturePath, `${JSON.stringify(computed, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(fixturePath, 'utf8'))).toEqual(computed);
    expect(Object.values(computed).every((result) => result.kind === 'highlighted')).toBe(true);
  });
});
