import { describe, expect, it } from 'vitest';
import {
  BRANCH_NAME_MESSAGE,
  MAX_BRANCH_NAME_LENGTH,
  branchNameSchema,
  isSafeBranchName,
} from '../src/branch-name';

describe('isSafeBranchName', () => {
  it.each(['main', 'release/2.0', 'feature/a_b-c', 'v1.2', 'x'.repeat(MAX_BRANCH_NAME_LENGTH)])(
    'accepts %s',
    (name) => {
      expect(isSafeBranchName(name)).toBe(true);
    },
  );
  it.each([
    '',
    '-main',
    '-upload-pack=x',
    'a..b',
    'a/.hidden',
    '.main',
    'main.lock',
    'a//b',
    'a/',
    '/a',
    'with space',
    'ünicode',
    'a~1',
    'feat+x',
    'a@b',
    'x'.repeat(MAX_BRANCH_NAME_LENGTH + 1),
  ])('rejects %j', (name) => {
    expect(isSafeBranchName(name)).toBe(false);
  });
});

describe('branchNameSchema', () => {
  it('trims, and reads an empty or blank field as null (follow the default branch)', () => {
    expect(branchNameSchema.parse('  release/2.0 ')).toBe('release/2.0');
    expect(branchNameSchema.parse('')).toBeNull();
    expect(branchNameSchema.parse('   ')).toBeNull();
  });

  it.each(['release 2.0', '-upload-pack=x', 'a..b', 'main.lock', 'ünicode', 'x'.repeat(256)])(
    'rejects %j with the message naming the allowed characters',
    (name) => {
      const parsed = branchNameSchema.safeParse(name);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([BRANCH_NAME_MESSAGE]);
    },
  );

  it('rejects a value that is not a string', () => {
    expect(branchNameSchema.safeParse(null).success).toBe(false);
  });

  it('names the allowed characters without an en or em dash', () => {
    expect(BRANCH_NAME_MESSAGE).toBe(
      'A branch name may use letters, digits, ".", "_", "-" and "/". It cannot start with "-" or ".", contain ".." or a space, or end with ".lock".',
    );
    expect(BRANCH_NAME_MESSAGE).not.toMatch(/[–—]/);
  });
});
