import { describe, expect, it } from 'vitest';
import {
  MAX_REPOSITORY_PATH_LENGTH,
  expandHomePath,
  repositoryPathInputSchema,
} from '../src/repository-path';

describe('expandHomePath', () => {
  it('expands ~ and ~/… to the home directory', () => {
    expect(expandHomePath('~', '/home/me')).toBe('/home/me');
    expect(expandHomePath('~/', '/home/me')).toBe('/home/me/');
    expect(expandHomePath('~/code/skills', '/home/me')).toBe('/home/me/code/skills');
  });

  it('leaves absolute paths, ~user and a ~ inside a name unchanged', () => {
    expect(expandHomePath('/srv/repo', '/home/me')).toBe('/srv/repo');
    expect(expandHomePath('~other/repo', '/home/me')).toBe('~other/repo');
    expect(expandHomePath('/srv/~/repo', '/home/me')).toBe('/srv/~/repo');
  });
});

describe('repositoryPathInputSchema', () => {
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

  it('rejects NUL characters, overlong paths and non-strings', () => {
    expect(message('/srv/re\0po')).toBe('The path contains a NUL character.');
    expect(message(`/${'a'.repeat(MAX_REPOSITORY_PATH_LENGTH)}`)).toBe(
      `The path is longer than ${MAX_REPOSITORY_PATH_LENGTH} characters.`,
    );
    expect(repositoryPathInputSchema.safeParse(null).success).toBe(false);
  });
});
