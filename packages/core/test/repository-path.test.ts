import { describe, expect, it } from 'vitest';
import {
  MAX_REPOSITORY_PATH_LENGTH,
  expandHomePath,
  isFilesystemRoot,
  pathRelation,
  repositoryLocationSchema,
  repositoryPathInputSchema,
  unseenOccurrencePaths,
} from '../src/repository-path';

describe('expandHomePath', () => {
  it('expands ~ and ~/… to the home directory', () => {
    expect(expandHomePath('~', '/home/me')).toBe('/home/me');
    expect(expandHomePath('~/', '/home/me')).toBe('/home/me/');
    expect(expandHomePath('~/code/skills', '/home/me')).toBe('/home/me/code/skills');
    // No textual normalisation: realpath resolves `..` after following symlinks.
    expect(expandHomePath('~/link/../b', '/home/me')).toBe('/home/me/link/../b');
  });

  it('leaves absolute paths, ~user and a ~ inside a name unchanged', () => {
    expect(expandHomePath('/srv/repo', '/home/me')).toBe('/srv/repo');
    expect(expandHomePath('~other/repo', '/home/me')).toBe('~other/repo');
    expect(expandHomePath('/srv/~/repo', '/home/me')).toBe('/srv/~/repo');
  });
});

describe('repositoryPathInputSchema', () => {
  const messages = (input: unknown) =>
    repositoryPathInputSchema.safeParse(input).error?.issues.map((issue) => issue.message);
  const message = (input: unknown) =>
    repositoryPathInputSchema.safeParse(input).error?.issues[0]?.message;

  it('accepts absolute and home-relative paths, trimmed', () => {
    expect(repositoryPathInputSchema.parse('  /srv/repo/  ')).toBe('/srv/repo/');
    expect(repositoryPathInputSchema.parse('~')).toBe('~');
    expect(repositoryPathInputSchema.parse('~/code')).toBe('~/code');
  });

  it('rejects empty, relative and ~user paths with a field message', () => {
    expect(message('   ')).toBe('Enter the path of a local directory.');
    const relative = 'Enter an absolute path, for example /home/you/project or ~/project.';
    expect(message('code/skills')).toBe(relative);
    expect(message('./skills')).toBe(relative);
    expect(message('~other/repo')).toBe(relative);
  });

  it('reports exactly one message per invalid path', () => {
    expect(messages('')).toEqual(['Enter the path of a local directory.']);
    expect(messages('rel\0ative')).toEqual(['The path contains a NUL character.']);
    expect(messages(`r${'a'.repeat(MAX_REPOSITORY_PATH_LENGTH)}`)).toHaveLength(1);
  });

  it('rejects NUL characters, overlong paths and non-strings', () => {
    expect(message('/srv/re\0po')).toBe('The path contains a NUL character.');
    expect(message(`/${'a'.repeat(MAX_REPOSITORY_PATH_LENGTH)}`)).toBe(
      `The path is longer than ${MAX_REPOSITORY_PATH_LENGTH} characters.`,
    );
    expect(repositoryPathInputSchema.safeParse(null).success).toBe(false);
  });
});

describe('isFilesystemRoot', () => {
  it('is true only for the filesystem root', () => {
    expect(isFilesystemRoot('/')).toBe(true);
    expect(isFilesystemRoot('/home')).toBe(false);
    expect(isFilesystemRoot('/home/me')).toBe(false);
  });
});

describe('pathRelation', () => {
  it('tells same, inside, contains and unrelated paths apart', () => {
    expect(pathRelation('/srv/repo', '/srv/repo')).toBe('same');
    expect(pathRelation('/srv/repo/skills', '/srv/repo')).toBe('inside');
    expect(pathRelation('/srv', '/srv/repo')).toBe('contains');
    expect(pathRelation('/', '/srv/repo')).toBe('contains');
    expect(pathRelation('/srv/other', '/srv/repo')).toBe('unrelated');
  });

  it('does not treat a shared name prefix or a name starting with .. as nesting', () => {
    expect(pathRelation('/srv/repository', '/srv/repo')).toBe('unrelated');
    expect(pathRelation('/srv/repo', '/srv/repository')).toBe('unrelated');
    expect(pathRelation('/srv/repo/..cache', '/srv/repo')).toBe('inside');
  });
});

describe('repositoryLocationSchema', () => {
  it('accepts canonical absolute locations verbatim, without trimming', () => {
    expect(repositoryLocationSchema.parse('/srv/repo ')).toBe('/srv/repo ');
    expect(repositoryLocationSchema.parse('/')).toBe('/');
  });

  it('rejects empty, relative, home-relative, NUL-containing and overlong values', () => {
    for (const value of [
      '',
      'srv/repo',
      '~/repo',
      '/srv/\0repo',
      `/${'a'.repeat(MAX_REPOSITORY_PATH_LENGTH)}`,
    ]) {
      expect(repositoryLocationSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('unseenOccurrencePaths', () => {
  const unseen = (active: string[], discovered: string[], unobserved: string[]) =>
    unseenOccurrencePaths({ active, discovered, unobserved });

  it('returns the active paths that were not discovered, in their order', () => {
    expect(unseen(['c', 'a', 'b/AGENTS.md', ''], ['a'], [])).toEqual(['c', 'b/AGENTS.md', '']);
    expect(unseen([], ['a'], [])).toEqual([]);
  });

  it('keeps a path equal to, inside or containing an unobserved path', () => {
    const active = ['a', 'a/b', 'a/b/c/SKILL.md', 'x/y', 'other', 'q'];
    // `a/b` equals; `a/b/c/SKILL.md` lies inside; `a` contains; `x/y` contains `x/y/z`.
    expect(unseen(active, [], ['a/b', 'x/y/z'])).toEqual(['other', 'q']);
  });

  it('compares whole segments, not string prefixes', () => {
    expect(unseen(['a', 'ab', 'ab/SKILL.md', 'a-b'], [], ['ab/SKILL.md'])).toEqual(['a', 'a-b']);
    expect(unseen(['ab', 'a.md'], [], ['a'])).toEqual(['ab', 'a.md']);
    // `a/` sorts after `a.md` and `a-b`, but before `a0`: the range lookup must find `a/x`.
    expect(unseen(['a'], [], ['a-b', 'a.md', 'a/x', 'a0'])).toEqual([]);
    expect(unseen(['a'], [], ['a-b', 'a.md', 'a0'])).toEqual(['a']);
  });

  it("treats '' and '.' as containing every path, on either side", () => {
    expect(unseen(['a', 'b/c'], [], ['.'])).toEqual([]);
    expect(unseen(['a', 'b/c'], [], [''])).toEqual([]);
    // The root skill contains any unobserved path, and with none it can go missing.
    expect(unseen(['', '.', 'a'], [], ['z/AGENTS.md'])).toEqual(['a']);
    expect(unseen(['', 'a'], [], [])).toEqual(['', 'a']);
  });

  it('compares Unicode paths exactly', () => {
    expect(unseen(['zażółć/SKILL.md', 'zazolc'], [], ['zażółć'])).toEqual(['zazolc']);
    expect(unseen(['café'], ['cafe\u0301'], [])).toEqual(['café']);
  });

  it('handles 10,000 occurrences', () => {
    const active = Array.from({ length: 10_000 }, (_, i) => `skills/s${i}`);
    const discovered = active.filter((_, i) => i % 2 === 0);
    const unobserved = ['skills/s1/SKILL.md', 'skills/s3/locked'];
    const result = unseen(active, discovered, unobserved);
    expect(result).toHaveLength(4_998);
    expect(result).not.toContain('skills/s1');
    expect(result).not.toContain('skills/s3');
    expect(result[0]).toBe('skills/s5');
  });
});
