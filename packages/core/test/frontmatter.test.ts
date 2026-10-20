import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { parse } from 'yaml';
import {
  MAX_FRONTMATTER_ALIAS_COUNT,
  MAX_FRONTMATTER_JSON_BYTES,
  parseFrontmatter,
} from '../src/frontmatter';

/** Parsing a 1 MB YAML source takes ~0.5 s locally and up to ~2 s on a loaded CI runner. */
const LARGE_SOURCE_TIMEOUT_MS = 20_000;

describe('parseFrontmatter', () => {
  afterEach(() => {
    vi.doUnmock('yaml');
    vi.resetModules();
  });

  it('returns content unchanged without frontmatter', () => {
    expect(parseFrontmatter('# hi')).toEqual({ frontmatter: {}, body: '# hi' });
  });

  it('splits a YAML mapping from the body', () => {
    expect(parseFrontmatter('---\r\nname: x\r\ntags: [a, b]\r\n---\r\n# Body\n')).toEqual({
      frontmatter: { name: 'x', tags: ['a', 'b'] },
      body: '# Body\n',
    });
  });

  it('strips a leading byte order mark', () => {
    expect(parseFrontmatter('﻿---\nname: x\n---\nbody')).toEqual({
      frontmatter: { name: 'x' },
      body: 'body',
    });
    expect(parseFrontmatter('﻿# hi').body).toBe('# hi');
  });

  it('treats an empty frontmatter block as no metadata', () => {
    expect(parseFrontmatter('---\n\n---\nbody')).toEqual({ frontmatter: {}, body: 'body' });
    expect(parseFrontmatter('---\n# only a comment\n---')).toEqual({ frontmatter: {}, body: '' });
  });

  it('reports invalid YAML without throwing', () => {
    const result = parseFrontmatter('---\nname: [unclosed\n---\nbody');
    expect(result.frontmatter).toEqual({});
    expect(result.error).toBeDefined();
    expect(result.body).toBe('body');
  });

  it('rejects non-mapping frontmatter', () => {
    expect(parseFrontmatter('---\n- a\n---\n').error).toMatch(/mapping/);
    expect(parseFrontmatter('---\njust text\n---\n')).toEqual({
      frontmatter: {},
      body: '',
      error: 'frontmatter is not a mapping',
    });
  });

  it('rejects frontmatter whose alias refers to itself, which JSON cannot store', () => {
    const result = parseFrontmatter('---\nname: x\nmetadata: &a {self: *a}\n---\nbody');
    expect(result).toEqual({
      frontmatter: {},
      body: 'body',
      error:
        'frontmatter cannot be stored as JSON: it contains an alias that refers to itself under the key "metadata"',
    });
    // A list that contains itself, deeper down: the warning names the top-level key.
    expect(parseFrontmatter('---\nname: x\na:\n  b: &l [1, *l]\n---\n').error).toBe(
      'frontmatter cannot be stored as JSON: it contains an alias that refers to itself under the key "a"',
    );
    // The whole mapping refers to itself.
    expect(parseFrontmatter('---\n&r\nself: *r\n---\n').error).toMatch(
      /refers to itself under the key "self"$/,
    );
  });

  it('keeps a node that two aliases share, which is not circular', () => {
    const { frontmatter, error } = parseFrontmatter(
      '---\nbase: &b {model: x, tags: [a]}\nfirst: *b\nsecond: *b\nnone: null\nn: 1.5\n---\n',
    );
    expect(error).toBeUndefined();
    expect(JSON.parse(JSON.stringify(frontmatter))).toEqual(frontmatter);
    expect(frontmatter.second).toEqual({ model: 'x', tags: ['a'] });
  });

  it.each([
    ['.inf', 'size: .inf', 'it contains .inf or .nan under the key "size"'],
    ['.nan', 'size: [1, .nan]', 'it contains .inf or .nan under the key "size"'],
    ['!!binary', 'logo: !!binary aGVsbG8=', 'it contains a Buffer under the key "logo"'],
    ['!!set', 'tags: !!set {a, b}', 'it contains a Set under the key "tags"'],
    ['!!omap', 'order: !!omap [{a: 1}]', 'it contains a Map under the key "order"'],
    ['!!timestamp', 'date: !!timestamp 2026-10-19', 'it contains a Date under the key "date"'],
  ])('rejects a %s value that JSON would drop or rewrite', (_tag, yaml, problem) => {
    expect(parseFrontmatter(`---\n${yaml}\n---\nbody`)).toEqual({
      frontmatter: {},
      body: 'body',
      error: `frontmatter cannot be stored as JSON: ${problem}`,
    });
  });

  it('keeps an untagged date and a mapping with a __proto__ key as plain JSON', () => {
    const { frontmatter, error } = parseFrontmatter(
      '---\ndate: 2026-10-19\n__proto__: {a: 1}\n---\n',
    );
    expect(error).toBeUndefined();
    expect(frontmatter.date).toBe('2026-10-19');
    expect(Object.getPrototypeOf(frontmatter)).toBe(Object.prototype);
    expect(JSON.stringify(frontmatter)).toBe('{"date":"2026-10-19","__proto__":{"a":1}}');
  });

  it('rejects an alias bomb beyond MAX_FRONTMATTER_ALIAS_COUNT without expanding it', () => {
    expect(MAX_FRONTMATTER_ALIAS_COUNT).toBe(100);
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let level = 1; level < 9; level += 1) {
      const previous = String.fromCharCode(96 + level);
      const name = String.fromCharCode(97 + level);
      levels.push(`${name}: &${name} [${Array(10).fill(`*${previous}`).join(', ')}]`);
    }
    const result = parseFrontmatter(`---\n${levels.join('\n')}\n---\nbody`);
    expect(result.frontmatter).toEqual({});
    expect(result.error).toMatch(/alias count/i);
    // Within the limit, aliases resolve as usual.
    expect(parseFrontmatter('---\na: &a [x]\nb: [*a, *a]\n---\n').frontmatter).toEqual({
      a: ['x'],
      b: [['x'], ['x']],
    });
  });

  // Regression (review of PR #44 at 2d668f3): `maxAliasCount` weights an alias by the aliases
  // inside the node it repeats, so 99 aliases of a 1 MB string passed it and became ~100 MB of
  // JSON in `parsedMetadata` — per file, under the 256 MiB scan limit.
  it(
    'rejects a 1 MB string repeated by 99 aliases, which the alias limit lets through',
    () => {
      const long = 'x'.repeat(1024 * 1024 - 600);
      const yaml = `name: big\na: &a "${long}"\nb: [${Array(99).fill('*a').join(', ')}]`;
      // The alias limit alone accepts it, and its JSON would be about 100 times the file.
      const expanded = parse(yaml, { maxAliasCount: MAX_FRONTMATTER_ALIAS_COUNT }) as {
        b: string[];
      };
      expect(expanded.b.reduce((sum, item) => sum + item.length, 0)).toBeGreaterThan(100_000_000);
      expect(parseFrontmatter(`---\n${yaml}\n---\nbody`)).toEqual({
        frontmatter: {},
        body: 'body',
        error: `frontmatter cannot be stored as JSON: it expands to more than ${MAX_FRONTMATTER_JSON_BYTES} bytes of JSON (the limit was reached under the key "b")`,
      });
    },
    LARGE_SOURCE_TIMEOUT_MS,
  );

  it('counts the exact UTF-8 bytes of the JSON against MAX_FRONTMATTER_JSON_BYTES', () => {
    expect(MAX_FRONTMATTER_JSON_BYTES).toBe(4 * 1024 * 1024);
    // Every kind of value, multi-byte and escaped text, nesting and shared aliases. 99 aliases of
    // a 41 000-character chunk bring the JSON near the limit from a small source (a 4 MiB source
    // is slow to parse on CI); `pad` fills the rest so that the whole is exactly at the limit,
    // then one byte over it. The last byte counted is the closing bracket of `last`.
    const rest =
      `chunk: &c "${'c'.repeat(41_000)}"\ncopies: [${Array(99).fill('*c').join(', ')}]\n` +
      'shared: &s {ok: true, off: false, none: null, n: -1.5e+30, list: [1, "two"]}\n' +
      'again: [*s, *s, []]\nempty: {}\ntext: "zażółć 😀 \\t \\" \\\\ \\x01"\nnested: {a: {b: [{}]}}\n' +
      'last: []';
    const sized = (padding: number) =>
      parseFrontmatter(`---\npad: "${'p'.repeat(padding)}"\n${rest}\n---\n`);
    const base = Buffer.byteLength(JSON.stringify(sized(0).frontmatter));
    expect(MAX_FRONTMATTER_JSON_BYTES - base).toBeGreaterThan(0);
    const atLimit = sized(MAX_FRONTMATTER_JSON_BYTES - base);
    expect(atLimit.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(atLimit.frontmatter))).toBe(MAX_FRONTMATTER_JSON_BYTES);
    expect(sized(MAX_FRONTMATTER_JSON_BYTES - base + 1)).toEqual({
      frontmatter: {},
      body: '',
      error: `frontmatter cannot be stored as JSON: it expands to more than ${MAX_FRONTMATTER_JSON_BYTES} bytes of JSON (the limit was reached under the key "last")`,
    });
  });

  it('names a long offending key only up to a safe length, escaped', () => {
    const key = `k\t${'e'.repeat(100)}`;
    expect(parseFrontmatter(`---\n"${key.replace('\t', '\\t')}": .inf\n---\n`).error).toBe(
      `frontmatter cannot be stored as JSON: it contains .inf or .nan under the key ${JSON.stringify(`${key.slice(0, 64)}…`)}`,
    );
  });

  it.each([
    ['a bigint', { n: 1n }, 'it contains an unsupported bigint value under the key "n"'],
    [
      'an undefined value',
      { u: undefined },
      'it contains an unsupported undefined value under the key "u"',
    ],
    [
      'an object without a constructor',
      { o: Object.create(Object.create(null) as object) },
      'it contains a non-plain object under the key "o"',
    ],
    [
      'an anonymous class instance',
      { o: new (class {})() },
      'it contains a non-plain object under the key "o"',
    ],
    ['a non-plain root mapping', new Map([['k', 'v']]), 'it contains a Map'],
  ])(
    'rejects %s a YAML parser could hand back, failing closed',
    async (_label, parsed, problem) => {
      // The `yaml` package does not produce these with the options used; a parser that did must
      // not get them into a JSON column.
      vi.resetModules();
      vi.doMock('yaml', () => ({ parse: () => parsed }));
      const { parseFrontmatter: parseWithOtherYaml } = await import('../src/frontmatter');
      expect(parseWithOtherYaml('---\nx: 1\n---\n').error).toBe(
        `frontmatter cannot be stored as JSON: ${problem}`,
      );
    },
  );

  it('accepts a null-prototype mapping from the parser', async () => {
    vi.resetModules();
    const bare = Object.assign(Object.create(null) as object, { k: 'v' });
    vi.doMock('yaml', () => ({ parse: () => ({ bare }) }));
    const { parseFrontmatter: parseWithOtherYaml } = await import('../src/frontmatter');
    expect(parseWithOtherYaml('---\nx: 1\n---\n')).toEqual({ frontmatter: { bare }, body: '' });
  });

  it('reports a non-Error thrown by the YAML parser without throwing', async () => {
    // The yaml package only throws Error instances; this guards the "never throws" contract
    // against a parser that throws something else.
    vi.resetModules();
    vi.doMock('yaml', () => ({
      parse: () => {
        throw 'parser exploded';
      },
    }));
    const { parseFrontmatter: parseWithBrokenYaml } = await import('../src/frontmatter');
    expect(parseWithBrokenYaml('---\nname: x\n---\nbody')).toEqual({
      frontmatter: {},
      body: 'body',
      error: 'parser exploded',
    });
  });
});
