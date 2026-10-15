import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter';

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
