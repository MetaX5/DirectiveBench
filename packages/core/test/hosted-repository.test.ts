import { describe, expect, it } from 'vitest';
import {
  CREDENTIALS_IN_URL_MESSAGE,
  MAX_REPOSITORY_URL_LENGTH,
  hostedRepositoryLocationSchema,
  looksLikeRepositoryUrl,
  parseRepositoryUrl,
} from '../src/hosted-repository';

describe('looksLikeRepositoryUrl', () => {
  it.each([
    'https://github.com/a/b',
    '  HTTPS://github.com/a/b  ',
    'http://example.com',
    'file:///tmp/repo',
    'ssh://git@github.com/a/b.git',
    'git@github.com:a/b.git',
    'user:token@github.com:a/b',
  ])('treats %s as a URL', (input) => {
    expect(looksLikeRepositoryUrl(input)).toBe(true);
  });

  it.each(['/home/you/project', '~/project', '~', 'relative/dir', 'C:\\repo', '/tmp/a@b:c'])(
    'treats %s as a path',
    (input) => {
      expect(looksLikeRepositoryUrl(input)).toBe(false);
    },
  );
});

describe('parseRepositoryUrl', () => {
  it.each([
    [
      'https://github.com/acme/agent-skills',
      'https://github.com/acme/agent-skills',
      'acme/agent-skills',
    ],
    [
      'https://github.com/Acme/Agent-Skills.git',
      'https://github.com/acme/agent-skills',
      'Acme/Agent-Skills',
    ],
    ['  https://GitHub.com/acme/skills/  ', 'https://github.com/acme/skills', 'acme/skills'],
    ['https://github.com/acme/skills.GIT/', 'https://github.com/acme/skills', 'acme/skills'],
    [
      'https://github.com:443/acme/my.skills_v2',
      'https://github.com/acme/my.skills_v2',
      'acme/my.skills_v2',
    ],
    ['https://github.com/a-b/x', 'https://github.com/a-b/x', 'a-b/x'],
  ])('accepts %s', (input, location, name) => {
    expect(parseRepositoryUrl(input)).toEqual({ ok: true, provider: 'github', location, name });
  });

  it.each([
    'https://user:ghp_abcdefghijklmnopqrstuvwxyz@github.com/acme/skills',
    'https://ghp_abcdefghijklmnopqrstuvwxyz@github.com/acme/skills',
    'https://user:pa ss@github.com/acme/skills',
    'https://user@example.com/acme/skills',
    'http://user:pw@github.com/acme/skills',
    'ssh://git@github.com/acme/skills.git',
  ])('rejects credentials in %s without repeating them', (input) => {
    const result = parseRepositoryUrl(input);
    expect(result).toEqual({
      ok: false,
      code: 'credentials-in-url',
      message: CREDENTIALS_IN_URL_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toMatch(/ghp_|pa ss|user:pw/);
  });

  it.each([
    ['git@github.com:acme/skills.git', 'SSH addresses are not supported'],
    ['http://github.com/acme/skills', 'Only https:// URLs'],
    ['ftp://github.com/acme/skills', 'Only https:// URLs'],
    ['https://gitlab.com/acme/skills', 'Only public repositories on github.com'],
    ['https://github.com.evil.example/acme/skills', 'Only public repositories on github.com'],
    ['https://www.github.com/acme/skills', 'Only public repositories on github.com'],
  ])('rejects the unsupported %s', (input, message) => {
    const result = parseRepositoryUrl(input);
    expect(result).toMatchObject({ ok: false, code: 'unsupported-provider' });
    expect(result.ok ? '' : result.message).toContain(message);
  });

  it.each([
    ['https://', 'not a valid URL'],
    ['https://github.com:99999/a/b', 'not a valid URL'],
    ['file:///tmp/repo', 'not as a file:// URL'],
    ['https://github.com:8443/acme/skills', 'port, query or fragment'],
    ['https://github.com/acme/skills?tab=readme', 'port, query or fragment'],
    ['https://github.com/acme/skills#readme', 'port, query or fragment'],
    ['https://github.com/acme', 'does not name a repository'],
    ['https://github.com/', 'does not name a repository'],
    ['https://github.com/acme/skills/tree/main', 'does not name a repository'],
    ['https://github.com//acme/skills', 'does not name a repository'],
    ['https://github.com/-acme/skills', 'does not name a repository'],
    ['https://github.com/acme/sk%20ills', 'does not name a repository'],
    ['https://github.com/acme/.git', 'does not name a repository'],
    ['https://github.com/acme/..', 'does not name a repository'],
    ['https://github.com/acme/./', 'does not name a repository'],
    ['https://github.com/acme/foo.git.git', 'does not name a repository'],
    [`https://github.com/acme/${'x'.repeat(101)}`, 'does not name a repository'],
    [`https://github.com/${'x'.repeat(MAX_REPOSITORY_URL_LENGTH)}`, 'longer than'],
  ])('rejects the invalid %s', (input, message) => {
    const result = parseRepositoryUrl(input);
    expect(result).toMatchObject({ ok: false, code: 'invalid-url' });
    expect(result.ok ? '' : result.message).toContain(message);
  });
});

describe('hostedRepositoryLocationSchema', () => {
  it('accepts only normalised locations', () => {
    expect(hostedRepositoryLocationSchema.safeParse('https://github.com/acme/skills').success).toBe(
      true,
    );
    for (const value of [
      'https://github.com/Acme/skills',
      'https://github.com/acme/skills.git',
      'https://github.com/acme/skills/',
      ' https://github.com/acme/skills',
      'https://user:pw@github.com/acme/skills',
      'https://gitlab.com/acme/skills',
      '/home/you/project',
      'x'.repeat(MAX_REPOSITORY_URL_LENGTH + 1),
    ]) {
      expect(hostedRepositoryLocationSchema.safeParse(value).success).toBe(false);
    }
  });
});
