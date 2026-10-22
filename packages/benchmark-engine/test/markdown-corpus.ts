/**
 * The generated corpus of the scanner's differential test (markdown-reference.test.ts): a
 * seeded, deterministic generator of small Markdown documents, built from block-level building
 * blocks — headings, paragraphs, fences, indented code, HTML blocks and comments, GFM tables,
 * thematic breaks — nested in block quotes and list items with varied marker padding, tabs and
 * lazy continuation lines, so that blocks interrupt and continue each other in many ways; and
 * the comparable form of a reading. `scripts/cmark-gfm-corpus.mjs` imports this module with
 * Node's type stripping, so it uses no TypeScript-only syntax.
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

  words(): string {
    return this.pick(['Alpha', 'Risks', 'Plan and scope', 'QA', 'Estimate', 'Backend API']);
  }

  atx(): string[] {
    const indent = this.pick(['', '', ' ', '   ', '    ', '\t']);
    const hashes = '#'.repeat(1 + this.int(7));
    const space = this.pick([' ', ' ', '  ', '\t', '']);
    const closing = this.pick(['', '', ' #', ' ##', '#', ' # ']);
    return [`${indent}${hashes}${space}${this.words()}${closing}`];
  }

  setext(): string[] {
    const lines = [this.words()];
    if (this.chance(0.3)) lines.push(`${this.pick(['', ' ', '    '])}${this.words()}`);
    lines.push(this.pick(['===', '---', '  ---  ', '    ---', '= =', '-', '=', '--- x']));
    return lines;
  }

  paragraph(): string[] {
    const count = 1 + this.int(3);
    return Array.from({ length: count }, () =>
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
      ]),
    );
  }

  fence(): string[] {
    const indent = this.pick(['', '', ' ', '   ', '    ']);
    const marker = this.pick(['```', '~~~', '````', '~~~~']);
    const lines = [`${indent}${marker}${this.pick(['', 'md', ' md `x`'])}`];
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
    if (close !== null) lines.push(close);
    return lines;
  }

  indentedCode(): string[] {
    return [this.pick(['    # Code', '\t# Code', '    | a | b |', '     ```'])];
  }

  html(): string[] {
    return this.pick([
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
      this.pick(['| Role | Hours |', 'Role | Hours', '| Role |', 'Role|Hours|Rate', '| Role']),
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
      ]),
    ];
    const rows = this.int(4);
    for (let i = 0; i < rows; i += 1) {
      lines.push(
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
        ]),
      );
    }
    return lines;
  }

  leaf(inList: boolean): string[] {
    const kind = this.int(10);
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
      default:
        return [this.pick(['---', '***', '* * *', '___', '- - -', ''])];
    }
  }

  quote(lines: string[]): string[] {
    const prefix = this.pick(['> ', '> ', '>', '>\t', ' > ']);
    return lines.map((line, index) => {
      if (index > 0 && this.chance(0.15)) return line; // a lazy continuation line
      return line === '' && this.chance(0.5) ? prefix.trimEnd() : `${prefix}${line}`;
    });
  }

  listItem(lines: string[]): string[] {
    const marker = this.pick(['-', '*', '+', '1.', '2)', '10.']);
    const padding = this.pick([' ', ' ', '  ', '   ', '    ', '     ', '\t', ' \t']);
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
  return Array.from({ length: options.cases }, () =>
    new Generator(next, options).blocks(0, 2 + Math.floor(next() * 7), false).join('\n'),
  );
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
 * its output — so HTML comments and tags, backticks and backslashes are removed and whitespace
 * is collapsed. Rows are cut or padded to the header's cells, as GFM does.
 */
export function comparable(blocks: Blocks): string[] {
  const text = (value: string) =>
    value
      .replace(/<!--[\s\S]*?-->|<[^>]*>|[`\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
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
