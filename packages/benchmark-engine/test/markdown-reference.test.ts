import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanMarkdown } from '../src/markdown';
import { comparable, generateDocuments, type GeneratorOptions } from './markdown-corpus';

/**
 * Differential test of the scanner against cmark-gfm, GitHub's own GFM parser (SPEC-118
 * FR-118-41/43, issue #110). The corpus documents are generated from a fixed seed; cmark-gfm's
 * readings were recorded with scripts/cmark-gfm-corpus.mjs, so CI needs no reference parser.
 * Equality also proves the property that matters most: the scanner never reports a heading or
 * a table row cmark-gfm does not (no false PASS of a document assertion).
 */
const corpus = JSON.parse(
  readFileSync(new URL('fixtures/cmark-gfm-corpus.json', import.meta.url), 'utf8'),
) as {
  generator: GeneratorOptions;
  reference: string;
  documentsSha256: string;
  expected: string[][];
};

const scanned = (document: string) => {
  const { headings, tables } = scanMarkdown(document);
  return comparable({
    headings,
    tables: tables.map((table) => [table.header, ...table.rows.map((row) => row.cells)]),
  });
};

describe(`scanMarkdown against ${corpus.reference}`, () => {
  const documents = generateDocuments(corpus.generator);

  it('generates the documents the expected readings were recorded for', () => {
    // A changed generator needs new readings: run scripts/cmark-gfm-corpus.mjs.
    const digest = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
    expect(digest).toBe(corpus.documentsSha256);
    expect(corpus.expected).toHaveLength(documents.length);
  });

  it(`reads all ${corpus.generator.cases} generated documents as cmark-gfm does (seed ${corpus.generator.seed})`, () => {
    const failures = documents.flatMap((document, index) => {
      const actual = scanned(document);
      const expected = corpus.expected[index] as string[];
      return JSON.stringify(actual) === JSON.stringify(expected)
        ? []
        : [
            `seed ${corpus.generator.seed}, case ${index}: ${JSON.stringify(document)}\n` +
              `  scanner   ${JSON.stringify(actual)}\n  cmark-gfm ${JSON.stringify(expected)}`,
          ];
    });
    expect(failures.slice(0, 5).join('\n')).toBe('');
  });
});
