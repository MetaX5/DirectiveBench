/**
 * Regenerates test/fixtures/cmark-gfm-corpus.json, the expected readings of the scanner's
 * differential test (SPEC-118 FR-118-41/43): the corpus documents, generated from the seed in
 * test/markdown-corpus.ts, are read by cmark-gfm — GitHub's own GFM parser — and its headings and
 * table rows are stored in their comparable form. Where the scanner deliberately reports less
 * (`MarkdownScan.notReported`, ADR-0013), cmark-gfm's readings of the document prefixes the test
 * compares with are stored too (`prefixLineCounts`): the lines before a stop, and the lines up to
 * a pipe-less table's delimiter row; so are the gaps themselves, which the scanner must keep. Run after changing the generator or those gaps:
 *
 *   pip install cmarkgfm==2025.10.22
 *   node packages/benchmark-engine/scripts/cmark-gfm-corpus.mjs   # Node 24 (type stripping)
 *
 * PYTHON selects the interpreter (default `python3`). Development only: CI reads the fixture.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanMarkdown } from '../src/markdown.ts';
import { comparable, generateDocuments, prefixLineCounts } from '../test/markdown-corpus.ts';

const generator = { seed: 110, cases: 10000, tabs: true, depth: 3, listTables: true };
const reference = 'cmark-gfm via cmarkgfm 2025.10.22 (table extension)';

const documents = generateDocuments(generator);
// The scanner's gaps per document (the test requires exactly these), and the prefixes they need
// as [document index, line count] pairs, read in one batch.
const gaps = documents.map((document) => scanMarkdown(document).notReported);
const prefixes = gaps.flatMap((notReported, index) =>
  [...new Set(prefixLineCounts(notReported))].map((lines) => [index, lines]),
);
const prefixText = (document, lines) =>
  document
    .split(/\r\n|\r|\n/)
    .slice(0, lines)
    .join('\n');
const readings = JSON.parse(
  execFileSync(
    process.env.PYTHON ?? 'python3',
    ['-I', fileURLToPath(new URL('cmark-gfm-blocks.py', import.meta.url))],
    {
      input: JSON.stringify([
        ...documents,
        ...prefixes.map(([index, lines]) => prefixText(documents[index], lines)),
      ]),
      maxBuffer: 256 * 1024 * 1024,
    },
  ).toString(),
).map(comparable);
const prefixReadings = {};
prefixes.forEach(([index, lines], position) => {
  prefixReadings[index] ??= {};
  prefixReadings[index][lines] = readings[documents.length + position];
});
const corpus = {
  generator,
  reference,
  documentsSha256: createHash('sha256').update(JSON.stringify(documents)).digest('hex'),
  expected: readings.slice(0, documents.length),
  notReported: Object.fromEntries(
    gaps.flatMap((notReported, index) => (notReported.length > 0 ? [[index, notReported]] : [])),
  ),
  prefixReadings,
};
const target = new URL('../test/fixtures/cmark-gfm-corpus.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(corpus)}\n`);
console.log(`Wrote ${documents.length} expected readings to ${fileURLToPath(target)}`);
