import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanMarkdown } from '../src/markdown';
import {
  comparable,
  generateDocuments,
  prefixLineCounts,
  readingDifference,
  type GeneratorOptions,
  type ReferenceReadings,
  type ScannerReading,
} from './markdown-corpus';

/**
 * Differential test of the scanner against cmark-gfm, GitHub's own GFM parser (SPEC-118
 * FR-118-41/43, issue #110). The corpus documents are generated from a fixed seed; cmark-gfm's
 * readings were recorded with scripts/cmark-gfm-corpus.mjs, so CI needs no reference parser.
 * The comparison is exact, which proves the property that matters most: the scanner never reports
 * a heading or a table row cmark-gfm does not (no false PASS of a document assertion). Where the
 * scanner deliberately reports less (ADR-0013), it names the line (`notReported`), and the test
 * compares with cmark-gfm's reading of the document up to that line (issue #128).
 */
const corpus = JSON.parse(
  readFileSync(new URL('fixtures/cmark-gfm-corpus.json', import.meta.url), 'utf8'),
) as {
  generator: GeneratorOptions;
  reference: string;
  documentsSha256: string;
  expected: string[][];
  prefixReadings: Record<string, Record<string, string[]>>;
};

const scanned = (document: string): ScannerReading => {
  const { headings, tables, notReported } = scanMarkdown(document);
  return {
    reading: comparable({
      headings,
      tables: tables.map((table) => [table.header, ...table.rows.map((row) => row.cells)]),
    }),
    notReported,
  };
};

const referenceOf = (index: number): ReferenceReadings => ({
  reading: corpus.expected[index] as string[],
  prefixes: corpus.prefixReadings[String(index)] ?? {},
});

/**
 * Why the scan of corpus document `index` is not cmark-gfm's reading, or null: the gaps must be
 * the ones the readings were recorded for (another stop line needs another reading), and the
 * reading must pass `readingDifference`.
 */
const corpusDifference = (scan: ScannerReading, index: number): string | null => {
  const reference = referenceOf(index);
  const recorded = Object.keys(reference.prefixes).join(',');
  const needed = [...new Set(prefixLineCounts(scan.notReported))].sort((a, b) => a - b).join(',');
  if (recorded !== needed) return `prefix readings recorded for [${recorded}], needed [${needed}]`;
  return readingDifference(scan, reference);
};

describe(`scanMarkdown against ${corpus.reference}`, () => {
  const documents = generateDocuments(corpus.generator);
  const scans = documents.map(scanned);

  it('generates the documents the expected readings were recorded for', () => {
    // A changed generator or changed gaps need new readings: run scripts/cmark-gfm-corpus.mjs.
    const digest = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
    expect(digest).toBe(corpus.documentsSha256);
    expect(corpus.expected).toHaveLength(documents.length);
    const indices = Object.keys(corpus.prefixReadings).map(Number);
    expect(indices.every((index) => index < documents.length)).toBe(true);
  });

  it(`reads all ${corpus.generator.cases} generated documents as cmark-gfm does (seed ${corpus.generator.seed})`, () => {
    const failures = documents.flatMap((document, index) => {
      const actual = scans[index] as ScannerReading;
      const reference = referenceOf(index);
      const difference = corpusDifference(actual, index);
      return difference === null
        ? []
        : [
            `seed ${corpus.generator.seed}, case ${index}: ${difference}\n  ${JSON.stringify(document)}\n` +
              `  scanner   ${JSON.stringify(actual)}\n  cmark-gfm ${JSON.stringify(reference)}`,
          ];
    });
    expect(failures.slice(0, 5).join('\n')).toBe('');
  });

  it('covers both gaps: scans that stop and pipe-less tables', () => {
    const reasons = scans.flatMap(({ notReported }) => notReported.map((gap) => gap.reason));
    expect(reasons.filter((r) => r === 'link-definition-underline').length).toBeGreaterThan(500);
    expect(reasons.filter((r) => r === 'pipeless-table').length).toBeGreaterThan(200);
  });

  // Constructed regressions (issue #128): a scanner that under-reports anywhere but at its
  // named gaps fails the comparison, on every corpus document where the mutation changes the
  // reading.
  const failsWherever = (
    mutate: (scan: ScannerReading, index: number) => ScannerReading | null,
  ) => {
    let mutated = 0;
    for (const [index, scan] of scans.entries()) {
      const wrong = mutate(scan, index);
      if (wrong === null) continue;
      mutated += 1;
      expect(corpusDifference(wrong, index), `case ${index}`).not.toBeNull();
    }
    return mutated;
  };

  it('fails a scanner that stops one block early but names the same stop line', () => {
    const mutated = failsWherever((scan) => {
      if (!scan.notReported.some((gap) => gap.reason !== 'pipeless-table')) return null;
      if (scan.reading.length === 0) return null;
      // Drop the last heading, or the last table with its rows.
      const reading = [...scan.reading];
      const lastTable = reading.findLastIndex((line) => line.startsWith('T'));
      if (lastTable >= 0) reading.splice(lastTable);
      else reading.pop();
      return { ...scan, reading };
    });
    expect(mutated).toBeGreaterThan(300);
  });

  it('fails a scanner that stops at an earlier line', () => {
    const mutated = failsWherever((scan, index) => {
      const stop = scan.notReported.find((gap) => gap.reason !== 'pipeless-table');
      if (stop === undefined || stop.line < 2) return null;
      const lines = (documents[index] as string).split(/\r\n|\r|\n/).slice(0, stop.line - 2);
      const early = scanned(lines.join('\n'));
      return {
        reading: early.reading,
        notReported: [
          ...early.notReported.filter((gap) => gap.reason === 'pipeless-table'),
          { line: stop.line - 1, reason: stop.reason },
        ],
      };
    });
    expect(mutated).toBeGreaterThan(500);
  });

  it('fails a scanner that drops a piped one-column table', () => {
    const mutated = failsWherever((scan) => {
      const reading = [...scan.reading];
      const table = reading.findIndex((line) => line.startsWith('T') && !line.includes(' ¦ '));
      if (table < 0) return null;
      let end = table + 1;
      while (reading[end]?.startsWith('R')) end += 1;
      reading.splice(table, end - table);
      return { ...scan, reading };
    });
    expect(mutated).toBeGreaterThan(100);
  });
});

describe('readingDifference', () => {
  const table = ['TRole ¦ Hours', 'RDev ¦ 24'];
  const reading = ['HPlan', 'HRisks', ...table];
  const exact = (actual: string[], expected: string[]) =>
    readingDifference({ reading: actual, notReported: [] }, { reading: expected, prefixes: {} });

  it('accepts equal readings only', () => {
    expect(exact(reading, reading)).toBeNull();
    expect(exact([], [])).toBeNull();
    expect(exact(['HPlan', ...table], reading)).toBe(
      'entry 1 differs: scanner TRole ¦ Hours, cmark-gfm HRisks',
    );
    expect(exact(['HPlan', 'HRisks'], reading)).toBe(
      'entry 2 differs: scanner (none), cmark-gfm TRole ¦ Hours',
    );
    // An extra heading, an extra row, an extra table, a changed cell, a reordered heading.
    expect(exact(['HPlan', 'HRisks', 'HFake', ...table], reading)).toBe(
      'entry 2 differs: scanner HFake, cmark-gfm TRole ¦ Hours',
    );
    expect(exact([...reading, 'RPM ¦ 10'], reading)).toBe(
      'entry 4 differs: scanner RPM ¦ 10, cmark-gfm (none)',
    );
    expect(exact([...reading, 'TA'], reading)).toBe(
      'entry 4 differs: scanner TA, cmark-gfm (none)',
    );
    expect(exact(['HPlan', 'HRisks', 'TRole ¦ Hours', 'RDev ¦ 42'], reading)).toBe(
      'entry 3 differs: scanner RDev ¦ 42, cmark-gfm RDev ¦ 24',
    );
    expect(exact(['HRisks', 'HPlan', ...table], reading)).toBe(
      'entry 0 differs: scanner HRisks, cmark-gfm HPlan',
    );
  });

  it('compares a stopped scan with the recorded reading of the lines before the stop', () => {
    const stopped = (actual: string[], line: number) =>
      readingDifference(
        { reading: actual, notReported: [{ line, reason: 'link-definition-underline' }] },
        { reading, prefixes: { '4': ['HPlan', 'TRole ¦ Hours'], '0': [] } },
      );
    expect(stopped(['HPlan', 'TRole ¦ Hours'], 5)).toBeNull();
    expect(stopped([], 1)).toBeNull();
    // One block early, or a block from below the stop.
    expect(stopped(['HPlan'], 5)).toBe('entry 1 differs: scanner (none), cmark-gfm TRole ¦ Hours');
    expect(stopped(['HPlan', 'HRisks', 'TRole ¦ Hours'], 5)).toBe(
      'entry 1 differs: scanner HRisks, cmark-gfm TRole ¦ Hours',
    );
    // A stop at a line nobody recorded a reading for.
    expect(stopped(['HPlan'], 4)).toBe('no cmark-gfm reading of lines 1-3 is recorded');
  });

  it('leaves out exactly the pipe-less table whose header line is named', () => {
    const pipeless = ['HPlan', 'TAlpha', 'R', ...table, 'TBeta'];
    const check = (actual: string[], lines: number[], prefixes: Record<string, string[]>) =>
      readingDifference(
        {
          reading: actual,
          notReported: lines.map((line) => ({ line, reason: 'pipeless-table' })),
        },
        { reading: pipeless, prefixes },
      );
    const prefixes = { '3': ['HPlan', 'TAlpha'], '9': ['HPlan', 'TAlpha', 'R', ...table, 'TBeta'] };
    expect(check(['HPlan', ...table], [2, 8], prefixes)).toBeNull();
    expect(check(['HPlan', ...table, 'TBeta'], [2], prefixes)).toBeNull();
    // A pipe-less table the scanner did not name is missing, so the reading differs.
    expect(check(['HPlan', ...table], [2], prefixes)).toBe(
      'entry 3 differs: scanner (none), cmark-gfm TBeta',
    );
    expect(check(['HPlan', ...table], [8], prefixes)).toBe(
      'entry 1 differs: scanner TRole ¦ Hours, cmark-gfm TAlpha',
    );
    // A header line without a recorded reading, or where cmark-gfm's reading does not end with
    // a one-column table without rows, or the same table named twice.
    expect(check(['HPlan', ...table], [4], prefixes)).toBe(
      'no cmark-gfm reading of lines 1-5 is recorded',
    );
    const notThere = (prefix: string[]) => check([], [2], { '3': prefix });
    for (const prefix of [[], ['HPlan'], ['TAlpha', 'R'], ['TRole ¦ Hours'], ['TOther']]) {
      expect(notThere(prefix)).toBe('cmark-gfm reads no pipe-less table with its header on line 2');
    }
    expect(check([], [2, 2], prefixes)).toBe(
      'cmark-gfm reads no pipe-less table with its header on line 2',
    );
  });
});
