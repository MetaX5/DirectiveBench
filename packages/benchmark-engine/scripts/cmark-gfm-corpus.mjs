/**
 * Regenerates test/fixtures/cmark-gfm-corpus.json, the expected readings of the scanner's
 * differential test (SPEC-118 FR-118-41/43): the corpus documents, generated from the seed in
 * test/markdown-corpus.ts, are read by cmark-gfm — GitHub's own GFM parser — and its headings and
 * table rows are stored in their comparable form. Run after changing the generator:
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
import { comparable, generateDocuments } from '../test/markdown-corpus.ts';

const generator = { seed: 110, cases: 10000, tabs: true, depth: 3, listTables: true };
const reference = 'cmark-gfm via cmarkgfm 2025.10.22 (table extension)';

const documents = generateDocuments(generator);
const readings = JSON.parse(
  execFileSync(
    process.env.PYTHON ?? 'python3',
    ['-I', fileURLToPath(new URL('cmark-gfm-blocks.py', import.meta.url))],
    { input: JSON.stringify(documents), maxBuffer: 256 * 1024 * 1024 },
  ).toString(),
);
const corpus = {
  generator,
  reference,
  documentsSha256: createHash('sha256').update(JSON.stringify(documents)).digest('hex'),
  expected: readings.map(comparable),
};
const target = new URL('../test/fixtures/cmark-gfm-corpus.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(corpus)}\n`);
console.log(`Wrote ${documents.length} expected readings to ${fileURLToPath(target)}`);
