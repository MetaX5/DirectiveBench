/**
 * The generated corpus of the scanner's differential test (markdown-reference.test.ts): a
 * seeded, deterministic generator of small Markdown documents, built from block-level building
 * blocks — headings, paragraphs, fences, indented code, HTML blocks and comments, GFM tables,
 * thematic breaks, link reference definitions — nested in block quotes and list items with varied
 * marker padding, tabs and lazy continuation lines, so that blocks interrupt and continue each
 * other in many ways. Lines also carry the characters on which cmark-gfm's whitespace differs from
 * JavaScript's (U+00A0 is content, line tabulation and form feed are whitespace in some places
 * only), lone pipes and a leading byte order mark (issue #116). Also the comparable form of a
 * reading and the comparison of two readings. `scripts/cmark-gfm-corpus.mjs` imports this module
 * with Node's type stripping, so it uses no TypeScript-only syntax.
 */

/** mulberry32: a small, fast 32-bit PRNG; the same seed always yields the same sequence. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GeneratorOptions {
  seed: number;
  cases: number;
  /** Tabs in indentation and after container markers. */
  tabs: boolean;
  /** Deepest nesting of block quotes and list items. */
  depth: number;
  /** GFM tables inside list items. */
  listTables: boolean;
}

class Generator {
  private readonly next: () => number;
  private readonly options: GeneratorOptions;

  constructor(next: () => number, options: GeneratorOptions) {
    this.next = next;
    this.options = options;
  }

  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  pick<T>(choices: readonly T[]): T {
    const items = this.options.tabs
      ? choices
      : choices.filter((item) => typeof item !== 'string' || !item.includes('\t'));
    return items[this.int(items.length)] as T;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /**
   * A character cmark-gfm reads differently from JavaScript's `trim` and `\s`: U+00A0 (content),
   * line tabulation and form feed (whitespace in table rows, not in an ATX heading or a tag line).
   */
  oddSpace(): string {
    return this.pick(['\u00a0', '\v', '\f']);
  }

  /** `line`, sometimes with odd whitespace at its end. */
  tail(line: string): string {
    return this.chance(0.12) ? `${line}${this.pick(['\u00a0', '\v', '\f', ' \f', '\t\v'])}` : line;
  }

  words(): string {
    return this.pick(['Alpha', 'Risks', 'Plan and scope', 'QA', 'Estimate', 'Backend API']);
  }

  atx(): string[] {
    const indent = this.pick(['', '', ' ', '   ', '    ', '\t']);
    const hashes = '#'.repeat(1 + this.int(7));
    const space = this.pick([' ', ' ', '  ', '\t', '', this.oddSpace()]);
    const closing = this.pick(['', '', ' #', ' ##', '#', ' # ', ` #${this.oddSpace()}`]);
    return [this.tail(`${indent}${hashes}${space}${this.words()}${closing}`)];
  }

  setext(): string[] {
    const lines = [this.tail(this.words())];
    if (this.chance(0.3)) lines.push(`${this.pick(['', ' ', '    '])}${this.words()}`);
    lines.push(
      this.tail(this.pick(['===', '---', '  ---  ', '    ---', '= =', '-', '=', '--- x'])),
    );
    return lines;
  }

  paragraph(): string[] {
    const count = 1 + this.int(3);
    return Array.from({ length: count }, () =>
      this.tail(
        this.pick([
          this.words(),
          this.words(),
          '1. Item',
          '2) Item',
          '- Item',
          '* Item',
          '+',
          '-',
          '10. Ten',
          '> Quote',
          '   indented text',
          '    deeper text',
          'a | b',
          '|',
          '   |',
          '\uFEFF# Not a heading',
        ]),
      ),
    );
  }

  fence(): string[] {
    const indent = this.pick(['', '', ' ', '   ', '    ']);
    const marker = this.pick(['```', '~~~', '````', '~~~~']);
    const lines = [this.tail(`${indent}${marker}${this.pick(['', 'md', ' md `x`'])}`)];
    const body = this.int(4);
    for (let i = 0; i < body; i += 1) {
      lines.push(
        this.pick([
          '# Hidden',
          '```',
          '~~~',
          '> ```',
          '- ```',
          '| a | b |',
          '|---|---|',
          '<!--',
          'Title',
          '===',
          '',
        ]),
      );
    }
    const close = this.pick([marker, marker, '```', '~~~', '`````', '    ```', '  ~~~', null]);
    if (close !== null) lines.push(this.tail(close));
    return lines;
  }

  indentedCode(): string[] {
    return [this.pick(['    # Code', '\t# Code', '    | a | b |', '     ```'])];
  }

  html(): string[] {
    const tag = this.pick(['<custom-tag>', '<span class="a">', '</em>', '<div>', '<x-y/>']);
    return this.pick([
      [this.tail(tag), '# After a tag line'],
      [`${tag}${this.oddSpace()}`, '# After a tag line'],
      ['<!--', '# Hidden', '-->'],
      ['<!-- # Inline -->'],
      ['<!--', '# Hidden'],
      ['<!-->', '# After empty comment'],
      ['  <!--', '| a | b |', '|---|---|', '-->'],
      ['text <!--', '# Shown'],
      ['<div>', '# Hidden in div'],
      ['<details>', '', '## Shown', '', '</details>'],
      ['<custom-tag>', '# Hidden in tag'],
      ['<span class="a" data-x=1>', '# Hidden in span'],
      ['<span', '# Shown'],
      ['<script>', '# Hidden', '</script>'],
      ['<?php', '# Hidden', '?>'],
      ['<!DOCTYPE html>', '# Shown'],
      ['<![CDATA[', '# Hidden', ']]>'],
    ]);
  }

  table(): string[] {
    const lines = [
      this.tail(
        this.pick([
          '| Role | Hours |',
          'Role | Hours',
          '| Role |',
          'Role|Hours|Rate',
          '| Role',
          '|',
          ' |',
          '   |',
          '| ',
          '| Role |\u00a0',
        ]),
      ),
      this.tail(
        this.pick([
          '|---|---|',
          '--|--',
          ':-: | -:',
          '| - | - |',
          '|---|',
          '---|---|---',
          '-|-',
          '- | -',
          '|:--|--:|',
          '|-',
          '|---|\f---|',
          '|\v---\v|',
          '|\u00a0---|',
        ]),
      ),
    ];
    const rows = this.int(4);
    for (let i = 0; i < rows; i += 1) {
      lines.push(
        this.tail(
          this.pick([
            '| Backend API | 24 |',
            'PM | 10',
            '| Short |',
            'plain line',
            '| a \\| b | 3 |',
            '    | indented | 1 |',
            '- list',
            '> quote',
            '<!--',
            '<div>',
            '<custom-tag>',
            '# Heading',
            '* * *',
            '```',
            '',
            '|',
            ' | ',
            '||',
            '[foo]: /url',
          ]),
        ),
      );
    }
    return lines;
  }

  /**
   * Link reference definitions (single- and multi-line labels, titles, several in a row) and what
   * may follow them: cmark-gfm reads an underline after definitions only as paragraph text, after
   * further text as a heading of that text.
   */
  linkDefinition(): string[] {
    const definitions = this.pick([
      ['[foo]: /url'],
      ['[foo]: /url "Title"'],
      ['[foo]:', '/url'],
      ['[foo', 'bar]: /url'],
      ['[Foo\tBar]: <x>'],
      ['[foo]: /url', '[bar]: /url'],
      ['[foo]: /url "multi', 'line title"'],
      ['[]: /url'],
      ['[foo]'],
      ['[foo] text: x'],
    ]);
    const after = this.pick([
      [],
      [],
      ['text'],
      ['---'],
      ['==='],
      ['text', '---'],
      ['text', '==='],
      ['| a | b |', '|---|---|'],
      ['|---|---|'],
      ['# Heading'],
    ]);
    return [...definitions.map((line) => this.tail(line)), ...after];
  }

  leaf(inList: boolean): string[] {
    const kind = this.int(11);
    if (inList && !this.options.listTables && (kind === 7 || kind === 8)) return this.paragraph();
    switch (kind) {
      case 0:
        return this.atx();
      case 1:
        return this.setext();
      case 2:
      case 3:
        return this.paragraph();
      case 4:
        return this.fence();
      case 5:
        return this.indentedCode();
      case 6:
        return this.html();
      case 7:
      case 8:
        return this.table();
      case 9:
        return [this.tail(this.pick(['---', '***', '* * *', '___', '- - -', '']))];
      default:
        return this.linkDefinition();
    }
  }

  quote(lines: string[]): string[] {
    const prefix = this.pick(['> ', '> ', '>', '>\t', ' > ', `>${this.oddSpace()}`]);
    return lines.map((line, index) => {
      if (index > 0 && this.chance(0.15)) return line; // a lazy continuation line
      return line === '' && this.chance(0.5) ? prefix.trimEnd() : `${prefix}${line}`;
    });
  }

  listItem(lines: string[]): string[] {
    const marker = this.pick(['-', '*', '+', '1.', '2)', '10.']);
    const padding = this.pick([
      ' ',
      ' ',
      '  ',
      '   ',
      '    ',
      '     ',
      '\t',
      ' \t',
      this.oddSpace(),
    ]);
    const spaces = padding === '\t' ? 4 - ((marker.length + 0) % 4) : padding.length;
    const width = marker.length + (spaces >= 1 && spaces <= 4 ? spaces : 1);
    return lines.map((line, index) => {
      if (index === 0) return `${marker}${line === '' ? '' : padding}${line}`;
      if (line === '') return '';
      const indent = this.pick([
        ' '.repeat(width),
        ' '.repeat(width),
        ' '.repeat(width),
        ' '.repeat(Math.max(width - 1, 0)),
        ' '.repeat(width + 2),
        '',
        '\t',
      ]);
      return `${indent}${line}`;
    });
  }

  block(depth: number, inList: boolean): string[] {
    if (depth < this.options.depth && this.chance(0.4)) {
      const list = this.chance(0.5);
      const inner = this.blocks(depth + 1, 1 + this.int(3), inList || list);
      return list ? this.listItem(inner) : this.quote(inner);
    }
    return this.leaf(inList);
  }

  blocks(depth: number, count: number, inList: boolean): string[] {
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
      if (i > 0 && this.chance(0.5)) lines.push('');
      lines.push(...this.block(depth, inList));
    }
    return lines;
  }
}

/** The corpus documents of `options`, in order. */
export function generateDocuments(options: GeneratorOptions): string[] {
  const next = random(options.seed);
  return Array.from({ length: options.cases }, () => {
    const generator = new Generator(next, options);
    // A leading byte order mark (kept by `readFile(…, 'utf8')`); cmark-gfm drops one, not two.
    const bom = generator.chance(0.1) ? generator.pick(['\uFEFF', '\uFEFF', '\uFEFF\uFEFF']) : '';
    return bom + generator.blocks(0, 2 + generator.int(7), false).join('\n');
  });
}

/** Headings and tables of one document as a reader reports them. */
export interface Blocks {
  headings: readonly string[];
  /** Per table: the header cells, then one entry of cells per body row. */
  tables: readonly (readonly (readonly string[])[])[];
}

/**
 * The comparable form of a reading: `H<heading>`, then per table `T<header>` and `R<row>`, cells
 * joined by ` ¦ `. Inline markup is not compared — the scanner reports source text, a renderer
 * its output — so HTML comments, processing instructions, CDATA sections and tags (inline HTML
 * may span lines), backticks, backslashes and link brackets are removed and whitespace is
 * collapsed. Rows are cut or padded to the header's cells, as GFM does.
 */
export function comparable(blocks: Blocks): string[] {
  const text = (value: string) => {
    // Repeated until stable, so a removal cannot leave a new tag behind (CodeQL
    // js/incomplete-multi-character-sanitization; this is a comparison, not sanitisation).
    let stripped = value;
    for (let previous = ''; previous !== stripped;) {
      previous = stripped;
      stripped = stripped.replace(
        /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[`\\[\]]/g,
        '',
      );
    }
    return stripped.replace(/\s+/g, ' ').trim();
  };
  const row = (cells: readonly string[], width: number) =>
    Array.from({ length: width }, (_, column) => text(cells[column] ?? '')).join(' ¦ ');
  return [
    ...blocks.headings.map((heading) => `H${text(heading)}`),
    ...blocks.tables.flatMap(([header = [], ...rows]) => [
      `T${row(header, header.length)}`,
      ...rows.map((cells) => `R${row(cells, header.length)}`),
    ]),
  ];
}

/** A comparable reading split into its headings and its tables (`T` line, then `R` lines). */
function grouped(reading: readonly string[]): { headings: string[]; tables: string[][] } {
  const headings: string[] = [];
  const tables: string[][] = [];
  for (const line of reading) {
    if (line.startsWith('H')) headings.push(line);
    else if (line.startsWith('T')) tables.push([line]);
    else tables.at(-1)?.push(line);
  }
  return { headings, tables };
}

/**
 * Why the scanner's comparable reading of `document` is not acceptable against cmark-gfm's, or
 * null when it is. Acceptable is equality, or exactly the scanner's deliberate under-reports
 * (ADR-0013), which can only report less, never more:
 *
 * - a setext underline below a paragraph that may start with a link reference definition ends the
 *   scan, so in a document with `]:` the scanner's headings and tables may stop early: each is
 *   then a prefix of cmark-gfm's, in order;
 * - a table without a pipe in its header or delimiter row is read but not reported; such a table
 *   has one column, so only one-column tables of cmark-gfm may be missing between the others.
 *
 * Everything the scanner does report must equal cmark-gfm's at its position: an extra, changed or
 * reordered heading, table or row is a difference (a possible false pass).
 */
export function readingDifference(
  document: string,
  scanner: readonly string[],
  reference: readonly string[],
): string | null {
  if (JSON.stringify(scanner) === JSON.stringify(reference)) return null;
  const stopped = document.includes(']:');
  const actual = grouped(scanner);
  const expected = grouped(reference);
  for (const [index, heading] of actual.headings.entries()) {
    if (expected.headings[index] !== heading) return `heading ${index} differs: ${heading}`;
  }
  const missing = expected.headings[actual.headings.length];
  if (missing !== undefined && !stopped) return `heading missing: ${missing}`;
  const oneColumn = (table: readonly string[]) => !(table[0] as string).includes(' ¦ ');
  const same = (a: readonly string[], b: readonly string[]) => a.join('\n') === b.join('\n');
  let next = 0;
  for (const table of actual.tables) {
    while (
      next < expected.tables.length &&
      !same(expected.tables[next] as string[], table) &&
      oneColumn(expected.tables[next] as string[])
    ) {
      next += 1;
    }
    const counterpart = expected.tables[next];
    if (counterpart === undefined || !same(counterpart, table)) {
      return `table differs: ${table.join(' / ')}`;
    }
    next += 1;
  }
  const rest = expected.tables.slice(next);
  if (!stopped && !rest.every(oneColumn)) {
    return `table missing: ${(rest.find((table) => !oneColumn(table)) as string[]).join(' / ')}`;
  }
  return null;
}
