import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  literalSearch,
  normalizeText,
  parseFirstNumber,
  scanMarkdown,
  splitTableRow,
} from '../src/markdown';

describe('scanMarkdown headings', () => {
  it('finds ATX headings of every level with optional closing sequences', () => {
    const { headings } = scanMarkdown(
      [
        '# One',
        '## Two ##',
        '   ###   Three   with   spaces  ',
        '#### Four #not-closing',
        '##### Five#',
        '###### Six\t#',
        '#',
        '## ##',
        '####### Seven is a paragraph',
        '#NoSpace is a paragraph',
        '    # Indented code',
        '\t# Tab-indented code',
      ].join('\n'),
    );
    expect(headings).toEqual([
      'One',
      'Two',
      'Three with spaces',
      'Four #not-closing',
      'Five#',
      'Six',
      '',
      '',
    ]);
  });

  it('finds setext headings, including multi-line ones, with any line endings', () => {
    const { headings } = scanMarkdown(
      'Estimate\r\n========\r\n\r\nRisks and\rassumptions\r---  \n\n---\nafter a rule\n   ===\n',
    );
    expect(headings).toEqual(['Estimate', 'Risks and assumptions', 'after a rule']);
  });

  it('does not count headings inside fenced code blocks', () => {
    const { headings } = scanMarkdown(
      [
        '````markdown',
        '# Hidden',
        '``` not a close',
        '```',
        '~~~~',
        '# Still hidden',
        '````',
        '# Visible',
        '~~~~',
        '# Hidden tilde',
        '~~~',
        '# Hidden: short close',
        '    ~~~~',
        '# Hidden: indented close',
        '~~~~~ ',
        'Paragraph',
        '``two backticks are not a fence',
        '``` info `with` backticks is not a fence',
        '# Last',
      ].join('\n'),
    );
    expect(headings).toEqual(['Visible', 'Last']);
  });

  it('counts headings in block quotes and list items, not their other lines', () => {
    const { headings } = scanMarkdown(
      [
        '> # Quoted',
        '> > ## Nested quote',
        '- # Listed',
        '12) ### Numbered',
        '> quote',
        '---',
        '',
        '- item',
        '  continuation',
        '---',
        '',
        '* * *',
        '',
        '    indented code',
        '---',
        '',
        '-not a list',
        '===',
      ].join('\n'),
    );
    expect(headings).toEqual(['Quoted', 'Nested quote', 'Listed', 'Numbered', '-not a list']);
  });

  it('does not count headings inside HTML comments', () => {
    const { headings } = scanMarkdown(
      [
        '<!--',
        '# Hidden',
        'still --> hidden is over',
        '# One',
        '<!-- # Inline --> ',
        '# Two',
        '   <!-- open',
        'Hidden',
        '===',
        '-->',
        '    <!-- indented is code -->',
        '# Three',
      ].join('\n'),
    );
    expect(headings).toEqual(['One', 'Two', 'Three']);
  });

  it('treats an unclosed fence as code to the end of the document', () => {
    expect(scanMarkdown('# A\n    ```\n# B\n```\n# C').headings).toEqual(['A', 'B']);
  });
});

describe('scanMarkdown tables', () => {
  it('reads GFM tables with alignment, escaped pipes and short rows', () => {
    const { tables } = scanMarkdown(
      [
        'Intro paragraph',
        '| Work item | Hours |',
        '| :--- | ---: |',
        '| Backend API | 24 |',
        'Widget | 20 \\| 22',
        '| Short |',
        '',
        'a | b',
        '--|--',
        '1 | 2',
        '# Heading ends a table',
        'x | y',
        ':-: | -',
        '> quote',
        '',
        'p | q',
        '---|---',
        '```',
        '| in | code |',
        '```',
      ].join('\n'),
    );
    expect(tables).toEqual([
      {
        header: ['Work item', 'Hours'],
        rows: [
          { text: '| Backend API | 24 |', cells: ['Backend API', '24'] },
          { text: 'Widget | 20 \\| 22', cells: ['Widget', '20 | 22'] },
          { text: '| Short |', cells: ['Short'] },
        ],
      },
      { header: ['a', 'b'], rows: [{ text: '1 | 2', cells: ['1', '2'] }] },
      { header: ['x', 'y'], rows: [] },
      { header: ['p', 'q'], rows: [] },
    ]);
  });

  it('requires a header line with a pipe and a matching delimiter row', () => {
    const { tables, headings } = scanMarkdown(
      [
        'a | b',
        '--- | --- | ---',
        '',
        'no pipe here',
        '| --- |',
        '',
        'a | b',
        '| --- | x |',
        '',
        'a | b',
        '    | --- | --- |',
        '',
        'Title',
        '---',
      ].join('\n'),
    );
    expect(tables).toEqual([]);
    expect(headings).toEqual(['Title']);
  });

  it('splits rows on unescaped pipes and keeps an escaped trailing pipe', () => {
    expect(splitTableRow('| a | b \\| c |')).toEqual(['a', 'b | c']);
    expect(splitTableRow('a|b\\|')).toEqual(['a', 'b|']);
    expect(splitTableRow('only')).toEqual(['only']);
  });
});

const containsLiteral = (text: string, phrase: string, caseSensitive: boolean) =>
  literalSearch(text, caseSensitive)(phrase);

describe('text normalisation', () => {
  it('collapses whitespace, trims and folds case', () => {
    expect(collapseWhitespace('  a \t\n b  ')).toBe('a b');
    expect(normalizeText(' Risks  AND\tAssumptions ')).toBe('risks and assumptions');
    expect(normalizeText(' QA ', true)).toBe('QA');
  });

  it('matches literals, never as regular expressions, with any whitespace run', () => {
    const text = 'Includes QA\n\tand project   management (PM).';
    expect(containsLiteral(text, 'qa and project management', false)).toBe(true);
    expect(containsLiteral(text, 'qa and project management', true)).toBe(false);
    expect(containsLiteral(text, '(PM).', true)).toBe(true);
    expect(containsLiteral(text, 'P.', false)).toBe(false);
    expect(containsLiteral(text, '.*', false)).toBe(false);
  });
});

describe('parseFirstNumber', () => {
  it.each([
    ['24', '.', 24],
    ['1 234,5', ',', 1234.5],
    ['1,234.5', '.', 1234.5],
    ['1.234,5', ',', 1234.5],
    ['8–12', '.', 8],
    ['8-12 h', '.', 8],
    ['about 16 h', '.', 16],
    ['-3.5', '.', -3.5],
    ['−7', '.', -7],
    ['x-5', '.', 5],
    ['PM-5', '.', 5],
    ['Sprint-2: 8', '.', 2],
    ['about -5', '.', -5],
    ['(-5)', '.', -5],
    ['.5', '.', 0.5],
    [',5', ',', 0.5],
    ['-.25 h', '.', -0.25],
    ['1.5', '.', 1.5],
    [`${'9'.repeat(400)}`, '.', null],
    [`.${'9'.repeat(400)}`, '.', 1],
    ['+4', '.', 4],
    ['1 000 000 000', '.', 1_000_000_000],
    ['12,5', '.', 12],
    ['1,2345', '.', 1],
    ['1,23', '.', 1],
    ['1.5', ',', 1],
    ['1.500', ',', 1500],
    ['3.', '.', 3],
    ['0.25', '.', 0.25],
    ['12 345 h', '.', 12345],
  ] as const)('parses %j with %j as %s', (text, separator, expected) => {
    expect(parseFirstNumber(text, separator)).toBe(expected);
  });

  it('returns null when the text has no digit', () => {
    expect(parseFirstNumber('n/a', '.')).toBeNull();
    expect(parseFirstNumber('', ',')).toBeNull();
  });
});

/** Fastest of three runs, in milliseconds. */
function fastest(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('linear time', () => {
  // Shapes that would be superlinear for a naive scanner: one huge line, many headings, many
  // unclosed fences, long table rows and long runs of separators.
  const shapes: Record<string, (size: number) => string> = {
    headings: (n) => '## Heading with some words\n'.repeat(n),
    'setext paragraphs': (n) => 'line of a long paragraph\n'.repeat(n) + '---\n',
    tables: (n) => `| a | b |\n|---|---|\n${'| Backend API | 1 234,5 |\n'.repeat(n)}`,
    'one long line': (n) => `${'| x '.repeat(n * 6)}|`,
    'pipes and dashes': (n) => `a | b\n${'-|'.repeat(n * 12)}\n`,
    'hashes and spaces': (n) => `#${' #'.repeat(n * 12)}x\n`,
    'backticks and tildes': (n) => '```\n~~~\n'.repeat(n),
    whitespace: (n) => ' \t'.repeat(n * 12),
    'nested quote markers': (n) => `${'> '.repeat(n * 12)}# x\n`,
    'nested list markers': (n) => `${'- 1. '.repeat(n * 5)}x\n`,
    'html comments': (n) => '<!-- x\n'.repeat(n) + '-->\n',
  };

  it.each(Object.keys(shapes))('scans %s in linear time', (name) => {
    const build = shapes[name] as (size: number) => string;
    const small = build(20_000);
    const large = build(80_000);
    const ratio =
      fastest(() => scanMarkdown(large)) /
      Math.max(
        fastest(() => scanMarkdown(small)),
        1,
      );
    // 4× the input; a quadratic scan would be ~16×.
    expect(ratio).toBeLessThan(10);
  });

  it('matches literals and parses numbers in linear time', () => {
    const small = `${'word '.repeat(50_000)}QA`;
    const large = `${'word '.repeat(200_000)}QA`;
    const literal = (text: string) => () => containsLiteral(text, 'word   QA', false);
    expect(fastest(literal(large)) / Math.max(fastest(literal(small)), 1)).toBeLessThan(10);
    const digits = (n: number) => `${'1 000'.repeat(n)}`;
    const number = (text: string) => () => parseFirstNumber(text, '.');
    expect(
      fastest(number(digits(200_000))) / Math.max(fastest(number(digits(50_000))), 1),
    ).toBeLessThan(10);
  });
});
