import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanMarkdown } from '../src/markdown';
import {
  comparable,
  generateDocuments,
  readingDifference,
  type GeneratorOptions,
} from './markdown-corpus';

/**
 * Differential test of the scanner against cmark-gfm, GitHub's own GFM parser (SPEC-118
 * FR-118-41/43, issue #110). The corpus documents are generated from a fixed seed; cmark-gfm's
 * readings were recorded with scripts/cmark-gfm-corpus.mjs, so CI needs no reference parser.
 * The comparison is exact for everything the scanner reports, which proves the property that
 * matters most: the scanner never reports a heading or a table row cmark-gfm does not (no false
 * PASS of a document assertion). Only its two deliberate under-reports (ADR-0013) are compared as
 * "scanner ⊆ cmark-gfm", by the narrow rule of `readingDifference` (issue #116).
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
      const difference = readingDifference(document, actual, expected);
      return difference === null
        ? []
        : [
            `seed ${corpus.generator.seed}, case ${index}: ${difference}\n  ${JSON.stringify(document)}\n` +
              `  scanner   ${JSON.stringify(actual)}\n  cmark-gfm ${JSON.stringify(expected)}`,
          ];
    });
    expect(failures.slice(0, 5).join('\n')).toBe('');
  });
});

describe('readingDifference', () => {
  const table = ['TRole ¦ Hours', 'RDev ¦ 24'];
  const reference = ['HPlan', 'HRisks', ...table];

  it('accepts equal readings and nothing else in a document without link definitions', () => {
    expect(readingDifference('doc', reference, reference)).toBeNull();
    expect(readingDifference('doc', [], [])).toBeNull();
    expect(readingDifference('doc', ['HPlan', ...table], reference)).toBe(
      'heading missing: HRisks',
    );
    expect(readingDifference('doc', ['HPlan', 'HRisks'], reference)).toBe(
      'table missing: TRole ¦ Hours / RDev ¦ 24',
    );
  });

  it('catches every over-report, also where an under-report is allowed', () => {
    for (const document of ['doc', '[foo]: /url\n---']) {
      // An extra heading, an extra row, an extra table, a changed cell, a reordered heading.
      expect(readingDifference(document, [...reference, 'HFake'], reference)).toBe(
        'heading 2 differs: HFake',
      );
      expect(readingDifference(document, [...reference, 'RPM ¦ 10'], reference)).toBe(
        'table differs: TRole ¦ Hours / RDev ¦ 24 / RPM ¦ 10',
      );
      expect(readingDifference(document, [...reference, 'TA', 'R1'], reference)).toBe(
        'table differs: TA / R1',
      );
      expect(
        readingDifference(document, ['HPlan', 'HRisks', 'TRole ¦ Hours', 'RDev ¦ 42'], reference),
      ).toBe('table differs: TRole ¦ Hours / RDev ¦ 42');
      expect(readingDifference(document, ['HRisks', 'HPlan', ...table], reference)).toBe(
        'heading 0 differs: HRisks',
      );
      // A one-column table cmark-gfm does not report is never acceptable.
      expect(readingDifference(document, [...reference, 'TA'], [...reference])).toBe(
        'table differs: TA',
      );
    }
  });

  it('accepts a scan that stopped early only in a document with a link definition', () => {
    const stopped = '[foo]: /url\n---';
    expect(readingDifference(stopped, ['HPlan'], reference)).toBeNull();
    expect(readingDifference(stopped, [], reference)).toBeNull();
    // A stop keeps a prefix: a heading missing in the middle is still a difference.
    expect(readingDifference(stopped, ['HRisks'], reference)).toBe('heading 0 differs: HRisks');
    const tables = ['TA ¦ B', 'R1 ¦ 2', 'TC ¦ D'];
    expect(readingDifference(stopped, ['TA ¦ B', 'R1 ¦ 2'], tables)).toBeNull();
    expect(readingDifference(stopped, ['TC ¦ D'], tables)).toBe('table differs: TC ¦ D');
  });

  it('accepts a missing one-column table (no pipe in its header or delimiter row) only', () => {
    const withPipeless = ['TAlpha', 'R', ...table, 'TBeta'];
    expect(readingDifference('doc', table, withPipeless)).toBeNull();
    expect(readingDifference('doc', [], ['TA ¦ B'])).toBe('table missing: TA ¦ B');
    expect(readingDifference('doc', ['TBeta'], withPipeless)).toBe('table differs: TBeta');
  });
});
