import { describe, expect, it } from 'vitest';
import {
  MAX_REPOSITORY_PATH_LENGTH,
  expandHomePath,
  isFilesystemRoot,
  pathRelation,
  repositoryPathInputSchema,
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
