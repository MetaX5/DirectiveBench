import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeEnv, claudeAuthProfile, ClaudeCodeError } from '../../src/claude-code';

const hostEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  LANG: 'C.UTF-8',
  HOME: '/home/user',
  USERPROFILE: '/home/user',
  CLAUDE_CONFIG_DIR: '/home/user/.config/claude',
  ANTHROPIC_API_KEY: 'sk-ant-host-key',
  ANTHROPIC_AUTH_TOKEN: 'host-token',
  ANTHROPIC_BASE_URL: 'https://gateway.example',
  ANTHROPIC_MODEL: 'opus',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  AWS_SECRET_ACCESS_KEY: 'aws',
  GITHUB_TOKEN: 'gh',
};

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ClaudeCodeError
      ? error.code
      : `not a ClaudeCodeError: ${String(error)}`;
  }
  return undefined;
}

describe('buildClaudeEnv', () => {
  it('keeps the real home and drops every credential variable in subscription mode (FR-118-02/03)', () => {
    const env = buildClaudeEnv({ authMode: 'subscription', baseEnv: hostEnv, tempDir: '/run/tmp' });
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HOME: '/home/user',
      USERPROFILE: '/home/user',
      TMPDIR: '/run/tmp',
      TEMP: '/run/tmp',
      TMP: '/run/tmp',
    });
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$|^CLAUDE_CODE_USE_/);
    }
  });

  it('keeps only what is set', () => {
    expect(
      buildClaudeEnv({ authMode: 'subscription', baseEnv: { HOME: '/h' }, tempDir: '/t' }),
    ).toEqual({ HOME: '/h', TMPDIR: '/t', TEMP: '/t', TMP: '/t' });
  });

  it('refuses subscription mode without an absolute HOME', () => {
    for (const HOME of [undefined, 'relative/home']) {
      expect(
        codeOf(() =>
          buildClaudeEnv({
            authMode: 'subscription',
            baseEnv: { PATH: '/bin', HOME },
            tempDir: '/t',
          }),
        ),
      ).toBe('auth-missing');
    }
  });

  it('isolates HOME and CLAUDE_CONFIG_DIR and passes only the given key in api-key mode', () => {
    const env = buildClaudeEnv({
      authMode: 'api-key',
      baseEnv: hostEnv,
      tempDir: '/run/tmp',
      isolatedHome: '/run/home',
      apiKey: 'sk-ant-run-key',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HOME: '/run/home',
      USERPROFILE: '/run/home',
      CLAUDE_CONFIG_DIR: '/run/home/.claude',
      TMPDIR: '/run/tmp',
      TEMP: '/run/tmp',
      TMP: '/run/tmp',
      ANTHROPIC_API_KEY: 'sk-ant-run-key',
    });
  });

  it('keeps only absolute PATH entries, which never resolve against the workspace (Codex round 4)', () => {
    const env = buildClaudeEnv({
      authMode: 'subscription',
      baseEnv: { ...hostEnv, PATH: ['.', '/usr/local/bin', '', 'bin', '/usr/bin'].join(delimiter) },
      tempDir: '/run/tmp',
    });
    expect(env.PATH).toBe(['/usr/local/bin', '/usr/bin'].join(delimiter));
    expect(
      buildClaudeEnv({
        authMode: 'subscription',
        baseEnv: { HOME: '/h', PATH: '.' },
        tempDir: '/t',
      }).PATH,
    ).toBe('');
  });

  it('refuses an empty, multi-line or unredactably short key', () => {
    for (const apiKey of [
      '',
      '   ',
      'a\nbcdefghi',
      'a\rbcdefghi',
      'a\0bcdefghi',
      'short12',
      '  short12  ',
    ]) {
      expect(
        codeOf(() =>
          buildClaudeEnv({
            authMode: 'api-key',
            baseEnv: hostEnv,
            tempDir: '/t',
            isolatedHome: '/h',
            apiKey,
          }),
        ),
        JSON.stringify(apiKey),
      ).toBe('auth-missing');
    }
  });

  it('requires absolute run-local directories', () => {
    expect(() =>
      buildClaudeEnv({ authMode: 'subscription', baseEnv: hostEnv, tempDir: 'tmp' }),
    ).toThrow(/temporary directory must be an absolute path/);
    expect(() =>
      buildClaudeEnv({
        authMode: 'api-key',
        baseEnv: hostEnv,
        tempDir: '/t',
        isolatedHome: 'home',
        apiKey: 'long-enough-key',
      }),
    ).toThrow(/isolated home directory must be an absolute path/);
  });
});

describe('claudeAuthProfile', () => {
  it('records user-profile isolation and the ambient warning only for subscription mode', () => {
    expect(claudeAuthProfile('subscription')).toEqual({
      isolationProfile: 'user-profile',
      warnings: ['ambient-user-config'],
    });
    expect(claudeAuthProfile('api-key')).toEqual({ isolationProfile: 'isolated', warnings: [] });
  });
});
