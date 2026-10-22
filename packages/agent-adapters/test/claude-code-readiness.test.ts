import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CODE_MIN_VERSION,
  checkClaudeCodeReadiness,
  claudeCodeModeReadiness,
  claudeCodeReadiness,
  isSupportedClaudeCodeVersion,
  parseClaudeAuthStatus,
  parseClaudeCodeVersion,
} from '../src/claude-code-readiness';

// A fake `claude` (POSIX shell script) on a test PATH stands in for the real CLI: no test reads
// a credential, logs in or reaches the network. Real installs are never consulted because every
// test controls PATH.
const posixOnly = describe.skipIf(process.platform === 'win32');

const PLANTED_KEY = 'sk-ant-api03-PLANTED-test-key-not-real';

/** What a logged-in `claude auth status` prints (shape observed on 2.1.302; values invented). */
const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'person@example.com',
  orgId: 'org-0000',
  orgName: 'Example Org',
  subscriptionType: 'max',
  configDirectory: '/home/person/.claude',
});
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface FakeClaude {
  bin: string;
  /** One line per invocation: `<cwd>|<argv>`. */
  calls: () => string[];
  /** The environment of the last `auth status` call. */
  authEnv: () => string;
}

function fakeClaude(options: { version?: string; auth?: string } = {}): FakeClaude {
  const bin = tempDir('fake-claude-');
  const log = join(tempDir('fake-claude-log-'), 'calls.log');
  const envLog = `${log}.env`;
  const version = options.version ?? 'echo "2.1.302 (Claude Code)"';
  const auth = options.auth ?? `echo '${LOGGED_IN}'`;
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/bin/sh',
      `echo "$PWD|$*" >> '${log}'`,
      'if [ "$1" = --setting-sources ]; then shift 2; fi',
      'case "$1" in',
      `  --version) ${version} ;;`,
      `  auth) env > '${envLog}'; ${auth} ;;`,
      '  *) echo "unexpected: $*" >&2; exit 64 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return {
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    authEnv: () => readFileSync(envLog, 'utf8'),
  };
}

/** A CLI environment with planted secrets and config overrides the probe must not pass on. */
function cliEnv(bin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: tempDir('home-'),
    CLAUDE_CONFIG_DIR: '/planted/config-dir',
    CLAUDE_CODE_OAUTH_TOKEN: 'planted-oauth-token',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_AUTH_TOKEN: 'planted-auth-token',
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseClaudeCodeVersion', () => {
  it('extracts major.minor.patch from the version line', () => {
    expect(parseClaudeCodeVersion('2.1.296 (Claude Code)')).toBe('2.1.296');
    expect(parseClaudeCodeVersion('10.20.30')).toBe('10.20.30');
  });

  it('returns null for missing or unrecognised output', () => {
    expect(parseClaudeCodeVersion(null)).toBeNull();
    expect(parseClaudeCodeVersion('Claude Code 2.1.296')).toBeNull();
    expect(parseClaudeCodeVersion('2.1 (Claude Code)')).toBeNull();
  });
});

describe('isSupportedClaudeCodeVersion', () => {
  it('compares against the SPEC-203 §7 minimum', () => {
    expect(CLAUDE_CODE_MIN_VERSION).toBe('2.1.259');
    expect(isSupportedClaudeCodeVersion('2.1.259')).toBe(true);
    expect(isSupportedClaudeCodeVersion('2.1.302')).toBe(true);
    expect(isSupportedClaudeCodeVersion('3.0.0')).toBe(true);
    expect(isSupportedClaudeCodeVersion('2.1.258')).toBe(false);
    expect(isSupportedClaudeCodeVersion('2.0.999')).toBe(false);
    expect(isSupportedClaudeCodeVersion('1.99.999')).toBe(false);
  });

  it('compares each part numerically, not as text', () => {
    expect(isSupportedClaudeCodeVersion('2.10.0', '2.9.0')).toBe(true);
    expect(isSupportedClaudeCodeVersion('2.9.0', '2.10.0')).toBe(false);
    expect(isSupportedClaudeCodeVersion('2.1.1000', '2.1.999')).toBe(true);
  });
});

describe('parseClaudeAuthStatus', () => {
  it('keeps only loggedIn and authMethod', () => {
    expect(parseClaudeAuthStatus(LOGGED_IN)).toEqual({ loggedIn: true, authMethod: 'claude.ai' });
    expect(parseClaudeAuthStatus(LOGGED_OUT)).toEqual({ loggedIn: false, authMethod: 'none' });
    expect(parseClaudeAuthStatus('{"loggedIn":true}')).toEqual({
      loggedIn: true,
      authMethod: null,
    });
  });

  it('drops an auth method that is not a short plain token', () => {
    for (const authMethod of ['has space', 'x'.repeat(41), 42, '', 'a/b', null]) {
      expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod }))).toEqual({
        loggedIn: true,
        authMethod: null,
      });
    }
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api_key"}')?.authMethod).toBe(
      'api_key',
    );
  });

  it('returns null unless the output is an object with a boolean loggedIn', () => {
    for (const output of ['', 'Logged in', 'null', '[]', '"x"', '{"loggedIn":"true"}', '{}']) {
      expect(parseClaudeAuthStatus(output)).toBeNull();
    }
  });
});

posixOnly('checkClaudeCodeReadiness', () => {
  it('reports binary-not-found when claude is not on PATH', async () => {
    const report = await checkClaudeCodeReadiness('subscription', { PATH: tempDir('empty-') });
    expect(report).toEqual({
      mode: 'subscription',
      ready: false,
      code: 'binary-not-found',
      detail: '`claude` was not found on PATH.',
      executablePath: null,
      version: null,
    });
  });

  it('reports version-unsupported below the minimum without asking for the login', async () => {
    const fake = fakeClaude({ version: 'echo "2.1.258 (Claude Code)"' });
    const report = await checkClaudeCodeReadiness('subscription', cliEnv(fake.bin));
    expect(report).toMatchObject({
      ready: false,
      code: 'version-unsupported',
      detail: 'Claude Code 2.1.258 is older than the minimum 2.1.259; update it.',
      executablePath: join(fake.bin, 'claude'),
      version: '2.1.258',
    });
    expect(fake.calls().map((call) => call.split('|')[1])).toEqual(['--version']);
  });

  it('reports version-unsupported when the version is unreadable or the command fails', async () => {
    for (const version of ['echo "Claude Code"', 'exit 1']) {
      const fake = fakeClaude({ version });
      const report = await checkClaudeCodeReadiness('api-key', cliEnv(fake.bin));
      expect(report).toMatchObject({
        ready: false,
        code: 'version-unsupported',
        detail: 'Could not read the Claude Code version from `claude --version`.',
        version: null,
      });
    }
  });

  describe('subscription mode', () => {
    it('is ready when auth status reports a login, keeping no personal field', async () => {
      const fake = fakeClaude();
      const report = await checkClaudeCodeReadiness(
        'subscription',
        cliEnv(fake.bin, { ANTHROPIC_API_KEY: PLANTED_KEY }),
      );
      expect(report).toEqual({
        mode: 'subscription',
        ready: true,
        code: null,
        detail: 'Logged in (claude.ai).',
        executablePath: join(fake.bin, 'claude'),
        version: '2.1.302',
      });
      const serialised = JSON.stringify(report);
      for (const personal of ['person@example.com', 'org-0000', 'Example Org', 'max', '.claude']) {
        expect(serialised).not.toContain(personal);
      }
    });

    it('runs `claude auth status --json` without user settings, secrets or overrides, in an empty directory', async () => {
      const fake = fakeClaude();
      await checkClaudeCodeReadiness(
        'subscription',
        cliEnv(fake.bin, { ANTHROPIC_API_KEY: PLANTED_KEY }),
      );
      const [, auth] = fake.calls();
      const [cwd, argv] = auth!.split('|');
      // Same settings sources as the subscription run: user settings (`apiKeyHelper`) excluded.
      expect(argv).toBe('--setting-sources project,local auth status --json');
      expect(cwd).toContain('directivebench-probe-');
      expect(cwd).not.toBe(process.cwd());
      const env = fake.authEnv();
      expect(env).toMatch(/^HOME=/m);
      for (const name of [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CONFIG_DIR',
      ]) {
        expect(env).not.toMatch(new RegExp(`^${name}=`, 'm'));
      }
      expect(env).not.toContain(PLANTED_KEY);
    });

    it('reports auth-mismatch for a login that is not a Claude subscription', async () => {
      const cases = [
        { method: 'api_key', reported: 'api_key' },
        { method: 'api_key_helper', reported: 'api_key_helper' },
        { method: 'console', reported: 'console' },
      ];
      for (const { method, reported } of cases) {
        const status = JSON.stringify({ loggedIn: true, authMethod: method });
        const fake = fakeClaude({ auth: `echo '${status}'` });
        const report = await checkClaudeCodeReadiness('subscription', cliEnv(fake.bin));
        expect(report).toMatchObject({
          ready: false,
          code: 'auth-mismatch',
          detail: `Logged in with ${reported}, not a Claude subscription: run \`claude\` and \`/login\` with a subscription account, or use API key mode.`,
        });
      }
    });

    it('does not count a user-level apiKeyHelper as a subscription login', async () => {
      // Emulates 2.1.302 with `apiKeyHelper` in ~/.claude/settings.json: without
      // `--setting-sources project,local` it reports `api_key_helper`, with it nobody is logged in.
      const bin = tempDir('fake-claude-helper-');
      writeFileSync(
        join(bin, 'claude'),
        [
          '#!/bin/sh',
          'case "$*" in',
          '  --version) echo "2.1.302 (Claude Code)" ;;',
          `  '--setting-sources project,local auth status --json') echo '${LOGGED_OUT}'; exit 1 ;;`,
          `  'auth status'*) echo '{"loggedIn":true,"authMethod":"api_key_helper"}' ;;`,
          '  *) exit 64 ;;',
          'esac',
          '',
        ].join('\n'),
      );
      chmodSync(join(bin, 'claude'), 0o755);
      const report = await checkClaudeCodeReadiness('subscription', cliEnv(bin));
      expect(report).toMatchObject({ ready: false, code: 'auth-missing' });
    });

    it('fails closed when auth status reports a login without a method', async () => {
      const fake = fakeClaude({ auth: `echo '{"loggedIn":true}'` });
      const report = await checkClaudeCodeReadiness('subscription', cliEnv(fake.bin));
      expect(report).toMatchObject({
        ready: false,
        code: 'auth-mismatch',
        detail:
          'Logged in with an unreported method, not a Claude subscription: run `claude` and `/login` with a subscription account, or use API key mode.',
      });
    });

    it('reports auth-missing when nobody is logged in', async () => {
      const fake = fakeClaude({ auth: `echo '${LOGGED_OUT}'; exit 1` });
      const report = await checkClaudeCodeReadiness('subscription', cliEnv(fake.bin));
      expect(report).toMatchObject({
        ready: false,
        code: 'auth-missing',
        detail: 'Not logged in: run `claude` and `/login`, or use API key mode.',
      });
    });

    it('reports auth-expired for an expired login', async () => {
      const fake = fakeClaude({ auth: 'echo "Login expired · Please run /login"; exit 1' });
      const report = await checkClaudeCodeReadiness('subscription', cliEnv(fake.bin));
      expect(report).toMatchObject({
        ready: false,
        code: 'auth-expired',
        detail: 'The login has expired: run `claude` and `/login`, or use API key mode.',
      });
    });

    it('does not read the expiry text from fields of a parsed status', async () => {
      const status = JSON.stringify({ loggedIn: false, orgName: 'Login expired Inc' });
      const fake = fakeClaude({ auth: `echo '${status}'; exit 1` });
      const report = await checkClaudeCodeReadiness('subscription', cliEnv(fake.bin));
      expect(report).toMatchObject({ ready: false, code: 'auth-missing' });
    });

    it('fails closed when a login is reported with a non-zero exit', async () => {
      const fake = fakeClaude({ auth: `echo '${LOGGED_IN}'; exit 2` });
      const report = await checkClaudeCodeReadiness('subscription', cliEnv(fake.bin));
      expect(report).toMatchObject({
        ready: false,
        code: 'auth-missing',
        detail: 'Login not confirmed: `claude auth status` gave no readable status (exit 2).',
      });
    });

    it('fails closed on unreadable output without echoing it', async () => {
      const fake = fakeClaude({ auth: `echo "token ${PLANTED_KEY}"` });
      const report = await checkClaudeCodeReadiness('subscription', cliEnv(fake.bin));
      expect(report).toMatchObject({
        ready: false,
        code: 'auth-missing',
        detail: 'Login not confirmed: `claude auth status` gave no readable status (exit 0).',
      });
      expect(JSON.stringify(report)).not.toContain(PLANTED_KEY);
    });

    it('fails closed when auth status cannot run or floods its output', async () => {
      const cases = [
        { auth: 'kill -9 $$', reason: 'could not be run' },
        { auth: `printf '%070000d' 0`, reason: 'printed more than 65536 bytes' },
      ];
      for (const { auth, reason } of cases) {
        const fake = fakeClaude({ auth });
        const report = await checkClaudeCodeReadiness('subscription', cliEnv(fake.bin));
        expect(report).toMatchObject({
          ready: false,
          code: 'auth-missing',
          detail: `Login not confirmed: \`claude auth status\` ${reason}.`,
        });
      }
    });
  });

  describe('api-key mode', () => {
    it('is ready when ANTHROPIC_API_KEY is non-empty, never running auth status', async () => {
      const fake = fakeClaude();
      const report = await checkClaudeCodeReadiness(
        'api-key',
        cliEnv(fake.bin, { ANTHROPIC_API_KEY: PLANTED_KEY }),
      );
      expect(report).toMatchObject({
        mode: 'api-key',
        ready: true,
        code: null,
        detail: 'ANTHROPIC_API_KEY is set.',
      });
      expect(JSON.stringify(report)).not.toContain(PLANTED_KEY);
      expect(fake.calls().map((call) => call.split('|')[1])).toEqual(['--version']);
    });

    it('reports auth-missing when the key is absent, empty or blank', async () => {
      const fake = fakeClaude();
      for (const key of [undefined, '', '  \n']) {
        const report = await checkClaudeCodeReadiness(
          'api-key',
          cliEnv(fake.bin, { ANTHROPIC_API_KEY: key }),
        );
        expect(report).toMatchObject({
          ready: false,
          code: 'auth-missing',
          detail: "ANTHROPIC_API_KEY is not set (or empty) in this process's environment.",
        });
      }
    });

    it('defaults to the process environment', async () => {
      const fake = fakeClaude();
      vi.stubEnv('PATH', fake.bin);
      vi.stubEnv('ANTHROPIC_API_KEY', PLANTED_KEY);
      expect((await checkClaudeCodeReadiness('api-key')).ready).toBe(true);
    });
  });
});

posixOnly('claudeCodeReadiness', () => {
  it('reports every auth mode, probing the login once', async () => {
    const fake = fakeClaude();
    const target = {
      executablePath: join(fake.bin, 'claude'),
      versionLine: '2.1.302 (Claude Code)',
    };
    expect(await claudeCodeReadiness(target, cliEnv(fake.bin))).toEqual([
      { mode: 'subscription', ready: true, code: null, detail: 'Logged in (claude.ai).' },
      {
        mode: 'api-key',
        ready: false,
        code: 'auth-missing',
        detail: "ANTHROPIC_API_KEY is not set (or empty) in this process's environment.",
      },
    ]);
    expect(fake.calls().map((call) => call.split('|')[1])).toEqual([
      '--setting-sources project,local auth status --json',
    ]);
  });

  it('reports binary-not-found for every mode when claude is missing', async () => {
    const readiness = await claudeCodeModeReadiness(
      'api-key',
      { executablePath: null, versionLine: null },
      { ANTHROPIC_API_KEY: PLANTED_KEY },
    );
    expect(readiness).toEqual({
      mode: 'api-key',
      ready: false,
      code: 'binary-not-found',
      detail: '`claude` was not found on PATH.',
    });
  });
});
