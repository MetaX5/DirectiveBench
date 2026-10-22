import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  literalSearch,
  MAX_MARKDOWN_NESTING,
  MAX_TABLE_AUTOCOMPLETED_CELLS,
  MAX_TABLE_ROW_CELLS,
  normalizeText,
  parseFirstNumber,
  scanMarkdown,
  splitTableRow,
} from '../src/markdown';
import { collectGarbage } from './helpers';

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

  it('does not count headings in fenced code inside block quotes and list items', () => {
    const { headings } = scanMarkdown(
      [
        '> ```markdown',
        '> # Quoted fence',
        '> ```',
        '# After quote',
        '- ```markdown',
        '  # Listed fence',
        '  ```',
        '',
        '1. ~~~',
        '   # Numbered fence',
        '   ~~~',
        '',
        '# Last',
      ].join('\n'),
    );
    expect(headings).toEqual(['After quote', 'Last']);
  });

  it('keeps quoted and list-prefixed fence lines inside an outer fence as code', () => {
    const { headings } = scanMarkdown(
      [
        '```markdown',
        '> ```',
        '# Hidden after quoted fence text',
        '> ```',
        '- ```',
        '# Hidden after listed fence text',
        '- ```',
        '```',
        '# Visible',
      ].join('\n'),
    );
    expect(headings).toEqual(['Visible']);
  });

  it('closes a fence only in the container it was opened in', () => {
    const { headings } = scanMarkdown(
      [
        '> ```',
        '> > ```',
        '> # Hidden: a deeper quote marker does not close it',
        '> ```',
        '# Quote closed',
        '- ```',
        '  # Hidden: list content',
        '  ```',
        '# List closed',
      ].join('\n'),
    );
    expect(headings).toEqual(['Quote closed', 'List closed']);
  });

  it('ends an unclosed fence with its container and reads the line again (GFM §4.5)', () => {
    const scan = (lines: string[]) => scanMarkdown(lines.join('\n')).headings;
    // The Codex repro: the quoted fence ends at the blank line; `# Fake` is inside the later
    // top-level fence, whose `> ~~~` line is code.
    expect(scan(['> ~~~', '> code', '', '~~~', '> ~~~', '# Fake', '~~~'])).toEqual([]);
    // Quote exit: a line without `>` ends the quote and the fence; the heading after it counts.
    expect(scan(['> ```', '> code', '# Visible after quote'])).toEqual(['Visible after quote']);
    expect(scan(['> ```', '> code', 'plain', '# Visible'])).toEqual(['Visible']);
    // List exit: content indented less than the item ends it.
    expect(scan(['- ```', '  code', '# Visible after list'])).toEqual(['Visible after list']);
    // Blank lines continue a list item, but end a block quote.
    expect(scan(['- ```', '  a', '', '  # Hidden', '  ```', '# After'])).toEqual(['After']);
    expect(scan(['> ```', '', '# After blank'])).toEqual(['After blank']);
    // Nested containers: leaving the inner list but staying in the quote.
    expect(scan(['> - ```', '>   # Hidden', '> # Visible in quote'])).toEqual(['Visible in quote']);
    // A top-level fence has no container to leave.
    expect(scan(['```', '', '> x', '- y', '# Hidden', '```'])).toEqual([]);
  });

  it('ends a list item at an ATX heading or a fence', () => {
    const { headings } = scanMarkdown(
      ['- item', '# Risks', 'Title', '===', '- item', '```', 'code', '```', 'After', '---'].join(
        '\n',
      ),
    );
    expect(headings).toEqual(['Risks', 'Title', 'After']);
  });

  // Self-audit against the GFM container rules the scanner relies on (block quotes §5.1, list
  // items §5.2, fences §4.5, setext §4.3, ATX §4.2): every case a reader sees as a heading counts,
  // and nothing else does.
  it.each([
    ['setext inside a block quote', ['> Title', '> ==='], ['Title']],
    ['multi-line setext inside a block quote', ['> a', '> b', '> ---'], ['a b']],
    ['a lazy line never underlines', ['> Title', '==='], []],
    ['a blank quote line ends the paragraph', ['> a', '>', '> ==='], []],
    ['setext inside a list item', ['- Title', '  ---'], ['Title']],
    ['an unindented --- ends the list item', ['- item', '---'], []],
    ['a new list item starts a new paragraph', ['- a', '- b', '  ---'], ['b']],
    ['ATX at a relative indent in a list item', ['- item', '    # Sub'], ['Sub']],
    [
      'blank lines keep the list item open',
      ['- a', '', '  # In item', '', '    # Deep'],
      ['In item', 'Deep'],
    ],
    ['an unindented paragraph ends the list item', ['- a', '', 'Para', '    # code'], []],
    [
      'a fence at a relative indent in a list item',
      ['- a', '    ```', '    # x', '    ```', '# y'],
      ['y'],
    ],
    [
      'an unindented fence line ends the item and opens a new fence',
      ['- a', '  ```', '  code', '```', '# hidden', '```', '# z'],
      ['z'],
    ],
    [
      'a comment on a list continuation line',
      ['- a', '    <!--', '    # Hidden', '    -->', '# After'],
      ['After'],
    ],
    [
      'only 1. interrupts a paragraph',
      ['Revenue grew in', '2026. Plan', '==='],
      ['Revenue grew in 2026. Plan'],
    ],
    ['1. interrupts a paragraph', ['Text', '1. # Item'], ['Item']],
    ['a block quote interrupts a paragraph', ['Para', '> # Q'], ['Q']],
  ] as const)('%s', (_, lines, expected) => {
    expect(scanMarkdown(lines.join('\n')).headings).toEqual(expected);
  });

  it('hides headings in HTML comments inside containers until the comment or container ends', () => {
    const scan = (lines: string[]) => scanMarkdown(lines.join('\n')).headings;
    expect(scan(['> <!--', '> # Hidden', '> -->', '# Shown'])).toEqual(['Shown']);
    expect(scan(['> <!--', '> x', '# Shown after quote'])).toEqual(['Shown after quote']);
    expect(scan(['- <!-- # Hidden -->', '# Shown after list comment'])).toEqual([
      'Shown after list comment',
    ]);
    expect(scan(['- <!--', '  # Hidden', '', '  -->', 'Title', '==='])).toEqual(['Title']);
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

// Issue #110 and the GFM block rules behind it. Every expectation below was checked against
// cmark-gfm, GitHub's own parser (the corpus test in markdown-reference.test.ts covers thousands of
// generated documents the same way).
describe('scanMarkdown GFM block structure (issue #110)', () => {
  const scan = (lines: string[]) => {
    const { headings, tables } = scanMarkdown(lines.join('\n'));
    return { headings, tables: tables.map((t) => [t.header, ...t.rows.map((r) => r.cells)]) };
  };

  it('reads list content after the marker padding: 1–4 spaces, tab stops, 5+ is code', () => {
    // Repro 1: `-   ` has content at column 4, so `  ```` ends the item and opens a top-level
    // fence that hides `# Risks`.
    expect(scan(['-   ```', '  ```', '# Risks', '```']).headings).toEqual([]);
    expect(
      scan([
        '-    # Four',
        '-     # Five',
        '-\t# Tab',
        '-  \t# Space and tab',
        '1.   # Three',
        '1.     # Five after one',
      ]).headings,
    ).toEqual(['Four', 'Tab', 'Space and tab', 'Three']);
    // Tabs inside block quotes follow tab stops too.
    expect(scan(['>\t\t# Code', '', '> \t# Quoted']).headings).toEqual(['Quoted']);
  });

  it('opens a list item with at most one blank line and keeps it open across blank lines', () => {
    expect(
      scan(['-', '    # In item', '', '-', '', '    # Code after empty item']).headings,
    ).toEqual(['In item']);
    expect(
      scan(['- a', '', '', '', '  # Still in item', '> b', '', '', '    # Code']).headings,
    ).toEqual(['Still in item']);
  });

  it('lets only bullets and `1.` with content interrupt a paragraph', () => {
    expect(scan(['Text', '2. # Not a list', '', 'Text', '-', '# After']).headings).toEqual([
      'Text',
      'After',
    ]);
  });

  it('ends a table at an HTML comment, which hides its lines (repro 2)', () => {
    expect(
      scan(['| Role | Hours |', '|---|---|', '<!--', '| Backend API | 24 |', '-->']).tables,
    ).toEqual([[['Role', 'Hours']]]);
  });

  it('hides the content of every HTML block kind until its end condition', () => {
    expect(
      scan([
        '<script>',
        '# Hidden',
        '</SCRIPT>',
        '# One',
        '<?x',
        '# Hidden',
        '?>',
        '# Two',
        '<!DOCTYPE html',
        '# Hidden',
        '>',
        '# Three',
        '<![CDATA[',
        '# Hidden',
        ']]>',
        '# Four',
        '<div class="x">',
        '# Hidden',
        '',
        '# Five',
        "<my-tag data-a=1 b='c' d>",
        '# Hidden',
        '',
        '# Six',
        '</my-tag >',
        '# Hidden',
        '',
        '# Seven',
        '<style media="x">',
        '# Hidden',
        '</style>',
        '# Eight',
        '<!',
        '# Nine',
        '<div',
        '# Hidden',
        '',
        '# Ten',
        '<div.',
        '# Eleven',
      ]).headings,
    ).toEqual([
      'One',
      'Two',
      'Three',
      'Four',
      'Five',
      'Six',
      'Seven',
      'Eight',
      'Nine',
      'Ten',
      'Eleven',
    ]);
  });

  it('recognises a complete tag line (kind 7) only when it is one', () => {
    expect(
      scan([
        '<a b="c',
        'x',
        '# h1',
        '<a b=c d=>',
        '# h2',
        '<a/b>',
        '# h3',
        '<a =x>',
        '# h4',
        '<1a>',
        '# h5',
        '<a b>x',
        '# h6',
        '<pre',
        '# h7',
        '</pre>',
        '<div/>',
        '# h8',
        '',
        '<!-->',
        '# h9',
      ]).headings,
    ).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h9']);
  });

  it('starts kind 7 on a lazy line but not inside a paragraph; kind 6 interrupts one', () => {
    expect(
      scan([
        'Para',
        '<my-tag>',
        '# Not hidden',
        '',
        '> Quote',
        '<my-tag>',
        '# Hidden by lazy kind 7',
        '',
        'Para',
        '<div>',
        '# Hidden by kind 6',
      ]).headings,
    ).toEqual(['Not hidden']);
  });

  it('reads tables as cmark-gfm does, reporting only those with pipes in both rows', () => {
    // No table later in a paragraph that held a delimiter row.
    expect(scan(['x', '-|-', 'c | d', '|-|-|']).tables).toEqual([]);
    // A header without a pipe is a table to GitHub but not to every reader: its lines are read
    // as a table (so `-` is no setext underline) but the table is not reported.
    expect(scan(['Role', '|---|', '-'])).toEqual({ headings: [], tables: [] });
    // A lazy header line keeps its indentation: `   |` is an empty first cell.
    expect(scan(['> Alpha', '   | Role |', '> |-|-|', '> | 1 | 2 |']).tables).toEqual([
      [
        ['', 'Role'],
        ['1', '2'],
      ],
    ]);
  });

  it("reads whitespace as cmark-gfm does, not JavaScript's Unicode spaces (Codex review)", () => {
    const table = (header: string, delimiter = '|---|---|') =>
      scanMarkdown(`${header}\n${delimiter}\n| B | 24 |`).tables;
    // A trailing U+00A0 is a third header cell: no table. Line tabulation and form feed are trimmed.
    expect(table('| Role | Hours |\u00a0')).toEqual([]);
    expect(table('| Role | Hours |', '|---|---|\u00a0')).toEqual([]);
    expect(table('| Role | Hours |\v')).toHaveLength(1);
    expect(table('|\fRole | Hours |\f')).toHaveLength(1);
    expect(scanMarkdown('| R | H |\n|---|---|\n| B\u00a0| 24 |').tables[0]?.rows[0]?.cells).toEqual(
      ['B\u00a0', '24'],
    );
    // An ATX closing sequence ends only before spaces and tabs.
    expect(scanMarkdown('# H #\u00a0\n# I #\f\n# J # ').headings).toEqual(['H #', 'I #', 'J']);
    // A tag line followed by U+00A0 is no HTML block; by a form feed it is.
    expect(scanMarkdown('<x>\u00a0\n# y').headings).toEqual(['y']);
    expect(scanMarkdown('<x>\f\n# y\n\n<x a\fb>\n# z').headings).toEqual([]);
    // Round 7: a line tabulation after a tag opens no HTML block; delimiter rows accept VT and FF.
    expect(scanMarkdown('<span>\v\n# x').headings).toEqual(['x']);
    expect(scanMarkdown('> <span>\v\n    text\n> 2. # Fake').headings).toEqual([]);
    expect(scanMarkdown('> text\n> ---\f\ntext\n2. # Fake').headings).toEqual([]);
    expect(scanMarkdown('> text\n> ---\v\ntext\n2. # Fake').headings).toEqual([]);
    expect(scanMarkdown('| a | b |\n|-\v|-|\f\n| c | d |').tables).toHaveLength(1);
  });

  it('ends a table at a body line that is only a pipe, as cmark-gfm does (Codex review)', () => {
    const rows = (line: string) =>
      scanMarkdown(`| R | H |\n|---|---|\n${line}\n| B | 24 |`).tables[0]?.rows.length;
    for (const lone of ['|', ' | ', '|\t', '|\f', '  |']) expect(rows(lone)).toBe(0);
    expect(rows('||')).toBe(2);
    expect(rows('| |')).toBe(2);
    expect(scanMarkdown('> | R | H |\n> |---|---|\n> |\n> | B | 24 |').tables[0]?.rows).toEqual([]);
    expect(scanMarkdown('- | R | H |\n  |---|---|\n  |\n  | B | 24 |').tables[0]?.rows).toEqual([]);
  });

  it('ignores one byte order mark at the start, as cmark-gfm does (Codex review)', () => {
    expect(scanMarkdown('\uFEFF```\n# Fake\n|a|b|\n|-|-|\n|x|42|')).toEqual({
      headings: [],
      tables: [],
    });
    expect(scanMarkdown('\uFEFF# Real').headings).toEqual(['Real']);
    expect(scanMarkdown('\uFEFF\uFEFF# Not').headings).toEqual([]);
  });

  it('stops the scan at a setext underline below a possible link definition (fail-safe)', () => {
    expect(scan(['# Before', '[a]: /url', '===', '# After']).headings).toEqual(['Before']);
    expect(scan(['[not a definition] text', '---', '# After']).headings).toEqual([
      '[not a definition] text',
      'After',
    ]);
    // A multi-line label (CommonMark example 541; Codex review).
    expect(scan(['[foo', 'bar]: /url', '---']).headings).toEqual([]);
    // cmark-gfm: `---` is paragraph text after definitions only, so `2. # Fake` cannot interrupt it.
    expect(scan(['[foo', 'bar]: /url', '---', '2. # Fake']).headings).toEqual([]);
    // cmark-gfm: the heading `text`, then an HTML block hiding `# Fake` (Codex review).
    expect(scan(['[foo]: /url', 'text', '---', '<x>', '# Fake']).headings).toEqual([]);
    expect(scan(['[foo]: /url', 'text', '---', 'a | b', '- | -']).tables).toEqual([]);
  });

  it(`follows ${MAX_MARKDOWN_NESTING} nested containers and stops the scan below them`, () => {
    const nested = (depth: number) => `${'> '.repeat(depth - 1)}- # Deep`;
    expect(scan(['# Before', nested(MAX_MARKDOWN_NESTING), '# After']).headings).toEqual([
      'Before',
      'Deep',
      'After',
    ]);
    expect(scan(['# Before', nested(MAX_MARKDOWN_NESTING + 1), '# After']).headings).toEqual([
      'Before',
    ]);
    // Containers the line leaves do not count: the limit is the depth of the line being read.
    const deepThenShallow = [`${'> '.repeat(MAX_MARKDOWN_NESTING)}a`, '- # Shallow'];
    expect(scan(deepThenShallow).headings).toEqual(['Shallow']);
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

  it('ends a table body at a list item, thematic break or block quote', () => {
    const body = (boundary: string) =>
      scanMarkdown(
        ['| Role | Hours |', '|---|---|', '| Dev | 5 |', boundary, 'PM | 10'].join('\n'),
      ).tables[0]?.rows.map((row) => row.cells[0]);
    for (const boundary of ['- no table anymore', '1. step', '* * *', '___', '> quote']) {
      expect([boundary, body(boundary)]).toEqual([boundary, ['Dev']]);
    }
    expect(body('| QA | 3 |')).toEqual(['Dev', 'QA', 'PM']);
    // A line indented four spaces starts indented code, which ends the table (cmark-gfm).
    expect(body('    ---')).toEqual(['Dev']);
  });

  it('finds tables with single-dash delimiters, inside list items and block quotes', () => {
    const { tables } = scanMarkdown(
      [
        'a | b',
        '-|-',
        '1 | 2',
        '',
        // A list item, not a delimiter row (cmark-gfm tries tables after every other block).
        'c | d',
        '- | -',
        '',
        '- Estimate:',
        '  | Item | Hours |',
        '  |---|---|',
        '  | Backend API | 24 |',
        '',
        // Lazy continuation lines of the item's paragraph: no table.
        '- a',
        '| Item | Hours |',
        '|---|---|',
        '',
        '> | Quoted | table |',
        '> | --- | --- |',
        '> | 1 | 2 |',
      ].join('\n'),
    );
    expect(tables).toEqual([
      { header: ['a', 'b'], rows: [{ text: '1 | 2', cells: ['1', '2'] }] },
      {
        header: ['Item', 'Hours'],
        rows: [{ text: '  | Backend API | 24 |', cells: ['Backend API', '24'] }],
      },
      { header: ['Quoted', 'table'], rows: [{ text: '> | 1 | 2 |', cells: ['1', '2'] }] },
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

/**
 * Fastest of three runs, in milliseconds, each after a full garbage collection, so a collection
 * left over from building the input cannot land inside one measurement (lesson 2026-10-21).
 */
async function fastest(run: () => void): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await collectGarbage();
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Growth of `run` from a 1× to an 8× input, divided by the growth of a linear baseline (split
 * into lines, collapse whitespace) on the same two inputs. Raw ratios depend on the machine:
 * once strings outgrow the CPU caches even the baseline grows ~16× for 8× the input. Normalised,
 * a linear scan measures ~1 and a quadratic one ~8; the bound sits between them.
 */
const SIZE_STEP = 8;
const MAX_LINEAR_RATIO = 4;

const baseline = (text: string) => () => {
  text.split('\n');
  text.replace(/\s+/g, ' ');
};

async function ratio(
  build: (size: number) => string,
  run: (text: string) => () => void,
  size: number,
): Promise<number> {
  const small = build(size);
  const large = build(size * SIZE_STEP);
  const growth = async (measure: (text: string) => () => void) =>
    (await fastest(measure(large))) / Math.max(await fastest(measure(small)), 0.05);
  return (await growth(run)) / (await growth(baseline));
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
    'quoted fences': (n) => '> ```\n> # x\n'.repeat(n),
    'one long quoted paragraph': (n) => `${'> quoted line of text\n'.repeat(n)}> ===\n`,
    'one long list item': (n) => `- item\n${'  continuation line\n'.repeat(n)}  ---\n`,
    'unclosed fences leaving quotes': (n) => '> ```\n> code\n\n'.repeat(n),
    'table body with breaks': (n) => `| a | b |\n|---|---|\n${'| 1 | 2 |\n* * *\n'.repeat(n)}`,
    'deep list items and blank lines': (n) => `${'- 1. '.repeat(8)}x\n${'\n'.repeat(n * 12)}`,
    'deep quotes and lazy lines': (n) => `${'> '.repeat(16)}x\n${'lazy line\n'.repeat(n)}`,
    'tabs after container markers': (n) => '>\t-\t1.\tx\n'.repeat(n),
    'tables in block quotes': (n) => `> | a | b |\n> |---|---|\n${'> | 1 | 2 |\n'.repeat(n)}`,
    'html tag lines': (n) => '<span class="a" data-x=1>\n\n'.repeat(n),
    'one long tag line': (n) => `<a${' b="c"'.repeat(n * 2)}>\n`,
    'tag lines in a paragraph': (n) => `Para\n${'<my-tag>\n'.repeat(n)}`,
    'one unclosed attribute': (n) => `<a b="${'x'.repeat(n * 12)}\n`,
    'underlines below a possible link definition': (n) =>
      `[x\n${'a\n'.repeat(n)}]: /url\n${'=\n'.repeat(n)}`,
    'underlines below bracketed paragraphs': (n) => `${'[x\na\n=\n'.repeat(n)}`,
  };

  it.each(Object.keys(shapes))(
    'scans %s in linear time',
    async (name) => {
      const build = shapes[name] as (size: number) => string;
      const scan = (text: string) => () => scanMarkdown(text);
      expect(await ratio(build, scan, 20_000)).toBeLessThan(MAX_LINEAR_RATIO);
    },
    60_000,
  );

  it('matches literals and parses numbers in linear time', async () => {
    const words = (size: number) => `${'word '.repeat(size)}QA`;
    const literal = (text: string) => () => containsLiteral(text, 'word   QA', false);
    expect(await ratio(words, literal, 50_000)).toBeLessThan(MAX_LINEAR_RATIO);
    const digits = (size: number) => '1 000'.repeat(size);
    const number = (text: string) => () => parseFirstNumber(text, '.');
    expect(await ratio(digits, number, 50_000)).toBeLessThan(MAX_LINEAR_RATIO);
  }, 60_000);
});

describe('scanMarkdown table limits (cmark-gfm)', () => {
  const sparse = (rows: number) => {
    const columns = 1000;
    return [
      ['Role', 'Hours', ...Array<string>(columns - 2).fill('c')].join('|'),
      Array<string>(columns).fill('-').join('|'),
      ...Array<string>(rows).fill('x'),
      'Dev|24',
      'more|1',
    ].join('\n');
  };

  it(`ends a table once it filled in more than ${MAX_TABLE_AUTOCOMPLETED_CELLS} cells (Codex review)`, () => {
    // Each `x` row fills in 999 cells; cmark-gfm 2025.10.22 reads `Dev|24` as a row after 524 of
    // them and as paragraph text after 525, with `more|1` continuing that paragraph.
    const before = scanMarkdown(sparse(524)).tables[0];
    expect(before?.rows).toHaveLength(525);
    expect(before?.rows.at(-1)?.text).toBe('Dev|24');
    const after = scanMarkdown(sparse(525)).tables;
    expect(after).toHaveLength(1);
    expect(after[0]?.rows).toHaveLength(525);
    expect(after[0]?.rows.at(-1)?.text).toBe('x');
  });

  it(`reads at most ${MAX_TABLE_ROW_CELLS} cells in a row (Codex review)`, () => {
    const row = (cells: number) => Array<string>(cells).fill('a').join('|');
    const delimiter = (cells: number) => Array<string>(cells).fill('-').join('|');
    expect(scanMarkdown(`${row(0xffff)}\n${delimiter(0xffff)}`).tables).toHaveLength(1);
    expect(scanMarkdown(`${row(0x10000)}\n${delimiter(0x10000)}`).tables).toEqual([]);
    // A wider body row ends the table: it and the next line are paragraph text.
    const wide = scanMarkdown(`a|b\n-|-\n${row(0x10000)}\nc|d`).tables;
    expect(wide).toEqual([{ header: ['a', 'b'], rows: [] }]);
  });
});
