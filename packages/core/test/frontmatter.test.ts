import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FRONTMATTER_ALIAS_COUNT, parseFrontmatter } from '../src/frontmatter';

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
      error: 'frontmatter cannot be stored as JSON: it contains an alias that refers to itself',
    });
    // A list that contains itself, deeper down.
    expect(parseFrontmatter('---\na:\n  b: &l [1, *l]\n---\n').error).toMatch(/refers to itself/);
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
    ['.inf', 'size: .inf', 'it contains .inf or .nan'],
    ['.nan', 'size: [1, .nan]', 'it contains .inf or .nan'],
    ['!!binary', 'logo: !!binary aGVsbG8=', 'it contains a Buffer'],
    ['!!set', 'tags: !!set {a, b}', 'it contains a Set'],
    ['!!omap', 'order: !!omap [{a: 1}]', 'it contains a Map'],
    ['!!timestamp', 'date: !!timestamp 2026-10-19', 'it contains a Date'],
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

  it.each([
    ['a bigint', { n: 1n }, 'it contains an unsupported bigint value'],
    ['an undefined value', { u: undefined }, 'it contains an unsupported undefined value'],
    [
      'an object without a constructor',
      { o: Object.create(Object.create(null) as object) },
      'it contains a non-plain object',
    ],
    ['an anonymous class instance', { o: new (class {})() }, 'it contains a non-plain object'],
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
