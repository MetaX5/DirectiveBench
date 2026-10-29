import { describe, expect, it } from 'vitest';
import { displayLines } from '../lib/output-files';
import {
  highlightLines,
  languageForPath,
  SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS,
  SYNTAX_HIGHLIGHT_MAX_BYTES,
  SYNTAX_HIGHLIGHT_MAX_LINE_CHARS,
  SYNTAX_LANGUAGE_BY_EXTENSION,
  type HighlightedLine,
  type HighlightResult,
  type SyntaxLanguage,
  type SyntaxTokenKind,
} from '../lib/syntax-highlight';

const KINDS: readonly (SyntaxTokenKind | null)[] = [
  'comment',
  'keyword',
  'string',
  'string-expression',
  'constant',
  'function',
  'parameter',
  'punctuation',
  'link',
  null,
];

function lines(result: HighlightResult): HighlightedLine[] {
  if (result.kind !== 'highlighted') throw new Error(`expected tokens, got ${result.reason}`);
  return result.lines;
}

const joined = (line: HighlightedLine) => line.map((token) => token.text).join('');

describe('constants (SPEC-123 §8.1)', () => {
  it('match the spec', () => {
    expect(SYNTAX_HIGHLIGHT_MAX_BYTES).toBe(262_144);
    expect(SYNTAX_HIGHLIGHT_MAX_LINE_CHARS).toBe(10_000);
    expect(SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS).toBe(500);
  });
});

describe('languageForPath (FR-123-71)', () => {
  it('maps exactly the listed extensions', () => {
    expect(SYNTAX_LANGUAGE_BY_EXTENSION).toEqual({
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'jsx',
      ts: 'typescript',
      mts: 'typescript',
      cts: 'typescript',
      tsx: 'tsx',
      json: 'json',
      css: 'css',
      scss: 'scss',
      html: 'html',
      htm: 'html',
      php: 'php',
      md: 'markdown',
      markdown: 'markdown',
      yaml: 'yaml',
      yml: 'yaml',
      sh: 'shellscript',
      bash: 'shellscript',
      py: 'python',
    });
  });

  it.each(Object.entries(SYNTAX_LANGUAGE_BY_EXTENSION))('maps .%s to %s', (extension, language) => {
    expect(languageForPath(`src/file.${extension}`)).toBe(language);
  });

  it.each([
    ['App.TSX', 'tsx'],
    ['README.Md', 'markdown'],
    ['src/block/render.php', 'php'],
    ['archive.tar.ts', 'typescript'],
    ['a.b/c.d/file.yml', 'yaml'],
    ['.github/workflows/ci.yaml', 'yaml'],
    ['.eslintrc.json', 'json'],
  ])('maps %s to %s', (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it.each([
    'Makefile',
    'README',
    '.env',
    'src/.env',
    'notes.txt',
    'archive.ts.gz',
    'file.',
    'src.ts/Makefile',
    'x.constructor',
    'x.__proto__',
    'x.toString',
  ])('returns null for %s', (path) => {
    expect(languageForPath(path)).toBeNull();
  });
});

// One sample per listed language, each with a construct of its own (FR-123-72 test).
const samples: Record<SyntaxLanguage, string> = {
  javascript: '// hi\nexport function add(a, b) {\n  return a + b + `${a}x`;\n}\n',
  jsx: 'export const App = () => <div className="x">{1}</div>;\n',
  typescript: 'interface A { b: number }\nconst x: A = { b: 1 }; // note\n',
  tsx: 'export function App({ n }: { n: number }) {\n  return <p title="n">{n}</p>;\n}\n',
  json: '{\n  "name": "x",\n  "count": 2,\n  "ok": true\n}\n',
  css: '.a > b { color: red; margin: 0 1px; }\n',
  scss: '$c: #fff;\n.a { .b { color: $c; } }\n',
  html: '<!doctype html>\n<p class="a">Hi <a href="/x">x</a></p>\n<script>let a = 1;</script>\n',
  php: "<?php\n/** Doc. */\nfunction render( $attributes ) {\n\treturn '<p>' . esc_html( $attributes['t'] ) . '</p>';\n}\n",
  markdown:
    '# Title\n\nSome *text* and [a link](https://example.com).\n\n```js\nconst a = 1;\n```\n',
  yaml: 'name: ci\non:\n  push: {}\njobs: # comment\n  test: [1, true]\n',
  shellscript: '#!/bin/sh\nset -e\necho "$HOME" | grep -q x && exit 1\n',
  python: 'def f(x: int) -> str:\n    """Doc."""\n    return f"{x}"  # c\n',
};

describe('highlightLines', () => {
  it.each(Object.entries(samples) as [SyntaxLanguage, string][])(
    'tokenizes %s with the JavaScript engine, keeping every line verbatim',
    async (language, sample) => {
      const result = lines(await highlightLines(sample, language));
      expect(result.map(joined)).toEqual(displayLines(sample));
      const tokens = result.flat();
      expect(tokens.every((token) => KINDS.includes(token.token))).toBe(true);
      expect(tokens.some((token) => token.token !== null)).toBe(true);
    },
  );

  it('colours the tokens of each kind it knows', async () => {
    const kinds = new Set<SyntaxTokenKind | null>();
    for (const [language, sample] of Object.entries(samples) as [SyntaxLanguage, string][]) {
      for (const token of lines(await highlightLines(sample, language)).flat()) {
        kinds.add(token.token);
      }
    }
    expect([...kinds].sort()).toEqual(
      expect.arrayContaining([
        'comment',
        'keyword',
        'string',
        'constant',
        'function',
        'parameter',
        'punctuation',
        'link',
      ]),
    );
  });

  it('merges neighbouring tokens of one kind', async () => {
    const [line] = lines(await highlightLines('// a b c', 'typescript'));
    expect(line).toEqual([{ text: '// a b c', token: 'comment' }]);
  });

  it('colours a block comment and a string that span lines (FR-123-76)', async () => {
    const result = lines(
      await highlightLines('/* one\n   two */\nconst s = `a\nb`;\n', 'typescript'),
    );
    expect(result[1]).toEqual([{ text: '   two */', token: 'comment' }]);
    expect(result[3]![0]).toEqual({ text: 'b`', token: 'string-expression' });
  });

  it('splits lines as FileView does: CR and CRLF are line breaks, no empty last line', async () => {
    const result = lines(await highlightLines('a\r\nb\rc\n', 'yaml'));
    expect(result.map(joined)).toEqual(['a', 'b', 'c']);
  });

  it('returns no lines for empty text', async () => {
    expect(await highlightLines('', 'json')).toEqual({ kind: 'highlighted', lines: [] });
  });

  it('keeps blank lines', async () => {
    expect(lines(await highlightLines('a: 1\n\nb: 2', 'yaml')).map(joined)).toEqual([
      'a: 1',
      '',
      'b: 2',
    ]);
  });

  it('returns plain text without a language', async () => {
    expect(await highlightLines('const a = 1;', null)).toEqual({
      kind: 'plain',
      reason: 'no-language',
    });
  });

  it('returns markup as token text, never as HTML (AC-15)', async () => {
    const hostile = '<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n';
    for (const language of ['html', 'markdown', 'php', 'typescript'] as const) {
      expect(lines(await highlightLines(hostile, language)).map(joined)).toEqual(
        displayLines(hostile),
      );
    }
  });

  describe('size bound (FR-123-74, NFR-123-07)', () => {
    // A multi-byte character ends the text, so a bound counted in characters would fail.
    const line = 'const a = 1;\n';
    const text = (bytes: number) => {
      const body = line.repeat(Math.floor((bytes - 2) / line.length));
      return body + 'x'.repeat(bytes - 2 - body.length) + 'é';
    };

    it('highlights exactly SYNTAX_HIGHLIGHT_MAX_BYTES of UTF-8', async () => {
      const exact = text(SYNTAX_HIGHLIGHT_MAX_BYTES);
      expect(Buffer.byteLength(exact)).toBe(262_144);
      expect(exact.length).toBe(262_143);
      const result = lines(await highlightLines(exact, 'typescript'));
      expect(result).toHaveLength(displayLines(exact).length);
      expect(
        result
          .at(-1)!
          .map((token) => token.text)
          .join(''),
      ).toMatch(/xé$/);
    });

    it('returns one byte more as plain text', async () => {
      const over = text(SYNTAX_HIGHLIGHT_MAX_BYTES + 1);
      expect(Buffer.byteLength(over)).toBe(262_145);
      expect(over.length).toBe(262_144);
      expect(await highlightLines(over, 'typescript')).toEqual({
        kind: 'plain',
        reason: 'too-large',
      });
    });

    // NFR-123-07 target is under 1 s after the highlighter exists; the bound is generous for a
    // loaded CI runner (lesson 2026-10-21) and still far from the per-line time limit times the
    // number of lines (about 10,000 lines here).
    it('highlights a generated 256 KiB TypeScript file in bounded time', async () => {
      await highlightLines('', 'typescript');
      const unit =
        '/** Adds. */\nexport function add(a: number, b: number): number {\n  return a + b; // sum\n}\n';
      const source = unit.repeat(Math.floor(SYNTAX_HIGHLIGHT_MAX_BYTES / unit.length));
      const started = performance.now();
      const result = lines(await highlightLines(source, 'typescript'));
      const elapsed = performance.now() - started;
      expect(result).toHaveLength(displayLines(source).length);
      expect(elapsed).toBeLessThan(30_000);
    }, 60_000);
  });

  describe('long lines (FR-123-75)', () => {
    const statement = 'let a = 1;'; // 10 characters

    it.each([
      ['alone', (line: string) => line],
      ['before another line', (line: string) => `${line}\nlet b = 2;`],
      ['after another line', (line: string) => `let b = 2;\n${line}`],
    ])('tokenizes a line of exactly SYNTAX_HIGHLIGHT_MAX_LINE_CHARS %s', async (_, place) => {
      const line = statement.repeat(SYNTAX_HIGHLIGHT_MAX_LINE_CHARS / statement.length);
      expect(line).toHaveLength(10_000);
      const result = lines(await highlightLines(place(line), 'typescript'));
      const tokens = result.find((tokens) => joined(tokens) === line)!;
      expect(tokens.length).toBeGreaterThan(1);
    });

    it('returns a longer line as one plain token, the rest of the file highlighted', async () => {
      const long = `${statement.repeat(1000)} `;
      expect(long).toHaveLength(10_001);
      const [first, second] = lines(await highlightLines(`${long}\nlet b = 2;`, 'typescript'));
      expect(first).toEqual([{ text: long, token: null }]);
      expect(second!.some((token) => token.token === 'keyword')).toBe(true);
    });
  });
});
