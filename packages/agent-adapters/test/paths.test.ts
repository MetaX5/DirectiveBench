import { describe, expect, it } from 'vitest';
import { PathEscapeError, resolveInside } from '../src/paths';

describe('resolveInside', () => {
  it('resolves relative paths below the root', () => {
    expect(resolveInside('/ws', 'a/b')).toBe('/ws/a/b');
    expect(resolveInside('/ws/', './a/../c')).toBe('/ws/c');
  });

  it('rejects absolute paths and NUL bytes as non-relative', () => {
    expect(() => resolveInside('/ws', '/etc/passwd')).toThrow(/must be relative/);
    expect(() => resolveInside('/ws', 'a\0b')).toThrow(PathEscapeError);
  });

  it('rejects the root itself and every parent escape', () => {
    for (const path of ['', '.', 'a/..', '..', '../x', 'a/../../b']) {
      expect(() => resolveInside('/ws', path), path).toThrow(/escapes the workspace/);
    }
  });

  it('accepts names that merely start with two dots', () => {
    expect(resolveInside('/ws', '..hidden')).toBe('/ws/..hidden');
  });

  it('throws an error named PathEscapeError', () => {
    expect(() => resolveInside('/ws', '..')).toThrow(
      expect.objectContaining({ name: 'PathEscapeError' }),
    );
  });
});
