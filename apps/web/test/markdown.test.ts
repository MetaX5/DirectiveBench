import { describe, expect, it } from 'vitest';
import {
  MAX_MARKDOWN_NESTING,
  isMarkdownPath,
  parseInline,
  parseMarkdown,
  safeHref,
  type Block,
  type Inline,
} from '../lib/markdown';

const text = (value: string): Inline => ({ kind: 'text', text: value });
const paragraph = (...children: Inline[]): Block => ({ kind: 'paragraph', children });

describe('safeHref', () => {
  it('keeps absolute http, https and mailto URLs, normalised', () => {
    expect(safeHref('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(safeHref('HTTP://Example.com')).toBe('http://example.com/');
    expect(safeHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  });

  it('rejects script and data URLs, including the forms browsers would still run', () => {
    for (const destination of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0001javascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
    ]) {
      expect(safeHref(destination), destination).toBeNull();
    }
  });

  it('makes relative links inert: they point into the repository, not this app', () => {
    expect(safeHref('references/checklist.md')).toBeNull();
    expect(safeHref('/artifacts')).toBeNull();
    expect(safeHref('#section')).toBeNull();
    expect(safeHref('')).toBeNull();
  });
});

describe('isMarkdownPath', () => {
  it('recognises Markdown and Cursor rule files only', () => {
    expect(['SKILL.md', 'a/README.MD', 'x.mdc', 'notes.markdown'].map(isMarkdownPath)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['run.sh', 'index.js', 'md', 'SKILL.md.bak'].map(isMarkdownPath)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('parseMarkdown blocks', () => {
  it('shows leading frontmatter as its own block', () => {
    expect(parseMarkdown('---\nname: x\ndescription: y\n---\n# Title\n')).toEqual([
      { kind: 'frontmatter', text: 'name: x\ndescription: y' },
      { kind: 'heading', level: 1, children: [text('Title')] },
    ]);
    expect(parseMarkdown('---\nname: x\n...\n')).toEqual([
      { kind: 'frontmatter', text: 'name: x' },
    ]);
    // An unclosed opening line is a thematic break, not frontmatter.
    expect(parseMarkdown('---\nname: x')).toEqual([{ kind: 'rule' }, paragraph(text('name: x'))]);
  });

  it('parses ATX headings with optional closing sequences', () => {
    expect(
      parseMarkdown('# One\n## Two ##\n###### Six #\n#\n### a#b\n#hashtag\n####### seven'),
    ).toEqual([
      { kind: 'heading', level: 1, children: [text('One')] },
      { kind: 'heading', level: 2, children: [text('Two')] },
      { kind: 'heading', level: 6, children: [text('Six')] },
      { kind: 'heading', level: 1, children: [] },
      { kind: 'heading', level: 3, children: [text('a#b')] },
      paragraph(text('#hashtag\n####### seven')),
    ]);
    expect(parseMarkdown('## ##')).toEqual([{ kind: 'heading', level: 2, children: [] }]);
  });

  it('keeps fenced code verbatim, with its language, up to a matching fence', () => {
    expect(parseMarkdown('```ts extra\nconst a = 1;\n\n<script>x</script>\n```\nafter')).toEqual([
      { kind: 'code', language: 'ts', text: 'const a = 1;\n\n<script>x</script>' },
      paragraph(text('after')),
    ]);
    expect(parseMarkdown('~~~~\n~~~\n```\n~~~~~')).toEqual([
      { kind: 'code', language: null, text: '~~~\n```' },
    ]);
    // An unclosed fence runs to the end; a backtick fence's info cannot contain a backtick.
    expect(parseMarkdown('```\nopen')).toEqual([{ kind: 'code', language: null, text: 'open' }]);
    expect(parseMarkdown('``` a`b')).toEqual([paragraph(text('``` a`b'))]);
  });

  it('parses thematic breaks and paragraphs split by blank lines', () => {
    expect(parseMarkdown('a\nb\n\n***\n- - -\n___\n\nc')).toEqual([
      paragraph(text('a\nb')),
      { kind: 'rule' },
      { kind: 'rule' },
      { kind: 'rule' },
      paragraph(text('c')),
    ]);
  });

  it('parses block quotes with lazy continuation and nesting', () => {
    expect(parseMarkdown('> a\nlazy\n> > deep\n\nafter')).toEqual([
      {
        kind: 'quote',
        children: [
          paragraph(text('a\nlazy')),
          { kind: 'quote', children: [paragraph(text('deep'))] },
        ],
      },
      paragraph(text('after')),
    ]);
    expect(parseMarkdown('> a\n# h')).toEqual([
      { kind: 'quote', children: [paragraph(text('a'))] },
      { kind: 'heading', level: 1, children: [text('h')] },
    ]);
  });

  it('parses bullet and ordered lists with nested content', () => {
    expect(parseMarkdown('- one\n  continued\n- two\n  - nested\n\n  more\n* other')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [
          [paragraph(text('one\ncontinued'))],
          [
            paragraph(text('two')),
            { kind: 'list', ordered: false, start: 1, items: [[paragraph(text('nested'))]] },
            paragraph(text('more')),
          ],
        ],
      },
      { kind: 'list', ordered: false, start: 1, items: [[paragraph(text('other'))]] },
    ]);
    expect(parseMarkdown('3. c\n4. d\n\n5. e\n1) f')).toEqual([
      {
        kind: 'list',
        ordered: true,
        start: 3,
        items: [[paragraph(text('c'))], [paragraph(text('d'))], [paragraph(text('e'))]],
      },
      { kind: 'list', ordered: true, start: 1, items: [[paragraph(text('f'))]] },
    ]);
  });

  it('handles list item edge cases: empty items, wide padding, lazy lines and endings', () => {
    expect(parseMarkdown('-\n-      code-like\n- a\nlazy\n# h')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [[], [paragraph(text('code-like'))], [paragraph(text('a\nlazy'))]],
      },
      { kind: 'heading', level: 1, children: [text('h')] },
    ]);
    // A blank line followed by unindented text ends the list; so does one at the end.
    expect(parseMarkdown('- a\n\nb')).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [[paragraph(text('a'))]] },
      paragraph(text('b')),
    ]);
    expect(parseMarkdown('- a\n\n')).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [[paragraph(text('a'))]] },
    ]);
    expect(parseMarkdown('- a\n\n1. b')).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [[paragraph(text('a'))]] },
      { kind: 'list', ordered: true, start: 1, items: [[paragraph(text('b'))]] },
    ]);
    expect(parseMarkdown('- a\n1. b')).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [[paragraph(text('a'))]] },
      { kind: 'list', ordered: true, start: 1, items: [[paragraph(text('b'))]] },
    ]);
    // A paragraph is interrupted by a list.
    expect(parseMarkdown('para\n- item')).toEqual([
      paragraph(text('para')),
      { kind: 'list', ordered: false, start: 1, items: [[paragraph(text('item'))]] },
    ]);
  });

  it('parses GFM tables, keeping short rows short and escaped pipes literal', () => {
    expect(parseMarkdown('| a | b |\n| :- | -: |\n| 1 | x \\| y |\n| 2 |\nafter')).toEqual([
      {
        kind: 'table',
        header: [[text('a')], [text('b')]],
        rows: [[[text('1')], [text('x | y')]], [[text('2')]]],
      },
      paragraph(text('after')),
    ]);
    expect(parseMarkdown('a | b\n--- | ---')).toEqual([
      { kind: 'table', header: [[text('a')], [text('b')]], rows: [] },
    ]);
    // Without a delimiter row it is a paragraph.
    expect(parseMarkdown('a | b\nc | d')).toEqual([paragraph(text('a | b\nc | d'))]);
    expect(parseMarkdown('a | b\n| x |')).toEqual([paragraph(text('a | b\n| x |'))]);
  });

  it('splits CRLF, CR and LF line endings alike', () => {
    expect(parseMarkdown('# a\r\nb\rc\n')).toEqual([
      { kind: 'heading', level: 1, children: [text('a')] },
      paragraph(text('b\nc')),
    ]);
  });

  it('keeps raw HTML as text', () => {
    expect(parseMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>')).toEqual([
      paragraph(text('<script>alert(1)</script>\n<img src=x onerror=alert(1)>')),
    ]);
  });

  it('stops nesting at the cap and shows deeper markers as text', () => {
    const deep = '>'.repeat(MAX_MARKDOWN_NESTING + 5) + ' x';
    let blocks = parseMarkdown(deep);
    let depth = 0;
    while (blocks[0]?.kind === 'quote') {
      blocks = blocks[0].children;
      depth += 1;
    }
    expect(depth).toBe(MAX_MARKDOWN_NESTING);
    expect(blocks).toEqual([paragraph(text('>>>>> x'))]);

    const list = Array.from(
      { length: MAX_MARKDOWN_NESTING + 2 },
      (_, i) => `${'  '.repeat(i)}- i${i}`,
    );
    expect(JSON.stringify(parseMarkdown(list.join('\n')))).toContain('- i17');
  });

  it('keeps a wide table with many empty rows as small as its input (PR #50 review)', () => {
    const columns = 25_000;
    const input = `${'|a'.repeat(columns)}\n${'|-'.repeat(columns)}\n${'|\n'.repeat(2_000)}`;
    const [table] = parseMarkdown(input);
    expect(table?.kind).toBe('table');
    const cells = table?.kind === 'table' ? table.rows.reduce((n, row) => n + row.length, 0) : -1;
    expect(cells).toBe(2_000);
    // Extra cells beyond the header are dropped.
    expect(parseMarkdown('a |\n- |\nx | y | z')).toEqual([
      { kind: 'table', header: [[text('a')]], rows: [[[text('x')]]] },
    ]);
  });

  it('parses pathological input in linear time', () => {
    const size = 100_000;
    const inputs = [
      '['.repeat(size),
      `${'['.repeat(size)}]`,
      `${'*a'.repeat(size / 2)}*`,
      '[a]'.repeat(size / 3),
      '`'.repeat(size),
      Array.from({ length: 400 }, (_, i) => '`'.repeat(i + 1)).join(' '),
      '*a '.repeat(size / 3),
      '_'.repeat(size),
      '**'.repeat(size / 2),
      `# ${' '.repeat(size)}x`,
      `- a${'\n'.repeat(size)}`,
      `${' '.repeat(size)}\u2028`,
      '<'.repeat(size),
    ];
    const started = performance.now();
    for (const input of inputs) parseMarkdown(input);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('parseInline', () => {
  it('parses code spans with matching backtick runs', () => {
    expect(parseInline('a `b` c ``d ` e`` ` x `')).toEqual([
      text('a '),
      { kind: 'code', text: 'b' },
      text(' c '),
      { kind: 'code', text: 'd ` e' },
      text(' '),
      { kind: 'code', text: 'x' },
    ]);
    expect(parseInline('`  `')).toEqual([{ kind: 'code', text: '  ' }]);
    expect(parseInline('``a`')).toEqual([text('``a`')]);
    expect(parseInline('`a\nb`')).toEqual([{ kind: 'code', text: 'a b' }]);
    expect(parseInline('`<script>`')).toEqual([{ kind: 'code', text: '<script>' }]);
  });

  it('parses strong and emphasis, but not intraword underscores', () => {
    expect(parseInline('**bold** and *em* and __b__ and _e_')).toEqual([
      { kind: 'strong', children: [text('bold')] },
      text(' and '),
      { kind: 'emphasis', children: [text('em')] },
      text(' and '),
      { kind: 'strong', children: [text('b')] },
      text(' and '),
      { kind: 'emphasis', children: [text('e')] },
    ]);
    expect(parseInline('snake_case_name and _x_y')).toEqual([text('snake_case_name and _x_y')]);
    expect(parseInline('* not * and ** ** and *')).toEqual([text('* not * and ** ** and *')]);
    expect(parseInline('**a *b* c**')).toEqual([
      {
        kind: 'strong',
        children: [text('a '), { kind: 'emphasis', children: [text('b')] }, text(' c')],
      },
    ]);
  });

  it('parses links, inert unless the destination is safe', () => {
    expect(
      parseInline('[site](https://example.com "title") [bad](javascript:alert(1)) [rel](./x.md)'),
    ).toEqual([
      {
        kind: 'link',
        href: 'https://example.com/',
        destination: 'https://example.com',
        children: [text('site')],
      },
      text(' '),
      {
        kind: 'link',
        href: null,
        destination: 'javascript:alert(1',
        children: [text('bad')],
      },
      text(') '),
      { kind: 'link', href: null, destination: './x.md', children: [text('rel')] },
    ]);
    expect(parseInline('[**b**](<https://e.com/a b>)')).toEqual([
      {
        kind: 'link',
        href: 'https://e.com/a%20b',
        destination: 'https://e.com/a b',
        children: [{ kind: 'strong', children: [text('b')] }],
      },
    ]);
    expect(parseInline('[<b](x)')).toEqual([
      { kind: 'link', href: null, destination: 'x', children: [text('<b')] },
    ]);
  });

  it('leaves brackets without a destination as text', () => {
    expect(parseInline('[a] [b] (c) [d](e')).toEqual([text('[a] [b] (c) [d](e')]);
    expect(parseInline('[a')).toEqual([text('[a')]);
  });

  it('never loads images', () => {
    expect(parseInline('![logo](https://tracker.example/pixel.png) ![]')).toEqual([
      { kind: 'image', alt: 'logo', destination: 'https://tracker.example/pixel.png' },
      text(' ![]'),
    ]);
  });

  it('parses autolinks and leaves other angle brackets as text', () => {
    expect(parseInline('<https://example.com> <javascript:alert(1)> <b>x</b> <')).toEqual([
      {
        kind: 'link',
        href: 'https://example.com/',
        destination: 'https://example.com',
        children: [text('https://example.com')],
      },
      text(' '),
      {
        kind: 'link',
        href: null,
        destination: 'javascript:alert(1)',
        children: [text('javascript:alert(1)')],
      },
      text(' <b>x</b> <'),
    ]);
  });

  it('honours backslash escapes of punctuation only', () => {
    expect(parseInline('\\*not em\\* \\[x](y) \\a \\')).toEqual([text('*not em* [x](y) \\a \\')]);
  });
});
