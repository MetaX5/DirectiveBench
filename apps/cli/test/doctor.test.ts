import * as fs from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeReadinessCode } from '@directivebench/agent-adapters';
import { agentReadinessHint, doctorCommand } from '../src/commands';
import type * as RuntimeModule from '../src/runtime';
import { ExitCode, checkSqlite, resolveAssets, type Assets } from '../src/runtime';
import { initialize } from '../src/setup';
import { fakeNodeVersion } from './support/node-version';

// existsSync/accessSync pass through to the real implementation unless a test overrides them, to
// simulate conditions a test process cannot create (a missing filesystem root, an unwritable
// directory regardless of the user running the tests).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), accessSync: vi.fn(actual.accessSync) };
});
vi.mock('../src/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeModule>();
  return {
    ...actual,
    resolveAssets: vi.fn(actual.resolveAssets),
    checkSqlite: vi.fn(actual.checkSqlite),
  };
});

const actualFs = await vi.importActual<typeof fs>('node:fs');
const actualRuntime = await vi.importActual<typeof RuntimeModule>('../src/runtime');
const sourceAssets = actualRuntime.resolveAssets;
const migrationCount = actualFs
  .readdirSync(sourceAssets().migrationsDir)
  .filter((f) => f.endsWith('.sql')).length;

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

const tempDirs: string[] = [];
const servers: Server[] = [];
let restoreNode: (() => void) | undefined;

function tempDir(): string {
  const dir = actualFs.mkdtempSync(join(tmpdir(), 'db-cli-doctor-'));
  tempDirs.push(dir);
  return dir;
}

/** A fake `claude`: `--version` prints `version`, `auth status` runs `auth`. */
function fakeClaudeScript(version: string, auth: string): string {
  return `#!/bin/sh\nif [ "$1" = --setting-sources ]; then shift 2; fi\ncase "$1" in\n  --version) echo "${version}" ;;\n  auth) ${auth} ;;\nesac\n`;
}

/** A fake `git` whose `version` prints `output` and exits with `exitCode`. */
function writeFakeGit(bin: string, output: string, exitCode = 0): void {
  actualFs.writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = version ]; then echo "${output}"; exit ${exitCode}; fi\nexit 1\n`,
    { mode: 0o755 },
  );
}

/** A PATH containing git 2.44.0, a logged-in `claude`, a broken `codex` and no `cursor-agent`. */
function fakeAgentPath(): string {
  const bin = tempDir();
  writeFakeGit(bin, 'git version 2.44.0');
  actualFs.writeFileSync(
    join(bin, 'claude'),
    fakeClaudeScript('2.1.302 (Claude Code)', `echo '{"loggedIn":true,"authMethod":"claude.ai"}'`),
    { mode: 0o755 },
  );
  actualFs.writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return bin;
}

async function listen(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const port = await listen();
  await new Promise((resolve) => servers.pop()?.close(resolve));
  return port;
}

function packagedAssets(): Assets {
  const dir = tempDir();
  return {
    mode: 'packaged',
    webDir: join(dir, 'web'),
    migrationsDir: sourceAssets().migrationsDir,
    examplesDir: join(dir, 'examples'),
    nextBin: join(dir, 'next'),
  };
}

async function initialisedDataDir(): Promise<string> {
  const root = join(tempDir(), 'data');
  (await initialize(root, sourceAssets().migrationsDir)).handle.close();
  return root;
}

async function runDoctor(dataDir: string, json = true) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await doctorCommand({ dataDir, json });
  const lines = log.mock.calls.map((call) => String(call[0]));
  log.mockRestore();
  if (!json) return { code, checks: [] as Check[], lines };
  const output = JSON.parse(lines.at(-1) ?? '') as { checks: Check[] };
  return { code, checks: output.checks, lines };
}

const SUBSCRIPTION_LOGIN_HINT =
  'Make sure `claude` starts and is logged in with a Claude subscription account (run `claude` and `/login`), or set ANTHROPIC_API_KEY to use API key mode.';
const API_KEY_HINT =
  'Set ANTHROPIC_API_KEY to your full API key (at least 8 characters, on one line) in the environment that runs DirectiveBench to use API key mode, or run `claude` and `/login` to use subscription mode.';
const GENERIC_HINT = 'Fix the problem described above, then run `directivebench doctor` again.';

const find = (checks: Check[], name: string) => checks.find((c) => c.name === name);

beforeEach(() => {
  vi.stubEnv('PATH', fakeAgentPath());
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('DIRECTIVEBENCH_HOST', '127.0.0.1');
  vi.stubEnv('GIT_SSL_CAINFO', undefined);
});

afterEach(async () => {
  restoreNode?.();
  restoreNode = undefined;
  vi.unstubAllEnvs();
  vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync);
  vi.mocked(fs.accessSync).mockImplementation(actualFs.accessSync);
  vi.mocked(resolveAssets).mockImplementation(sourceAssets);
  vi.mocked(checkSqlite).mockReset().mockImplementation(actualRuntime.checkSqlite);
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const dir of tempDirs.splice(0)) actualFs.rmSync(dir, { recursive: true, force: true });
});

describe('doctor', () => {
  it('reports a healthy installation in text form', async () => {
    const dataDir = await initialisedDataDir();
    vi.stubEnv('DIRECTIVEBENCH_PORT', String(await freePort()));
    vi.mocked(resolveAssets).mockReturnValue(packagedAssets());

    const { code, lines } = await runDoctor(dataDir, false);

    expect(code).toBe(ExitCode.Ok);
    expect(lines.filter((line) => !line.startsWith('ok  '))).toEqual([]);
    expect(lines).toContain(`ok    data-dir           ${dataDir}`);
    expect(lines).toContain(`ok    config             ${join(dataDir, 'config.json')}`);
    expect(lines).toContain(
      `ok    database           ${migrationCount}/${migrationCount} migrations applied`,
    );
    expect(lines.find((l) => l.includes(' port '))).toMatch(/127\.0\.0\.1:\d+ is free$/);
    expect(lines).toContain(
      'ok    agent:claude-code  Claude Code found (2.1.302 (Claude Code)); runs benchmarks with `directivebench benchmark run`',
    );
    expect(lines).toContain('ok    agent:claude-code:subscription ready: Logged in (claude.ai).');
    expect(lines).toContain(
      "ok    agent:claude-code:api-key not ready (auth-missing): ANTHROPIC_API_KEY is not set (or empty) in this process's environment.",
    );
    expect(lines).toContain(
      'ok    agent:codex        OpenAI Codex CLI found (version unknown); benchmark execution not implemented yet',
    );
    expect(lines).toContain(
      'ok    agent:cursor       Cursor Agent CLI not found on PATH (optional)',
    );
    const bin = (process.env.PATH ?? '').split(delimiter)[0] ?? '';
    expect(lines).toContain(
      `ok    git                git version 2.44.0 (${join(bin, 'git')}); hosted repositories: yes`,
    );
    expect(lines).toContain(
      "ok    git:ca-bundle      GIT_SSL_CAINFO not set (git's default CA bundle)",
    );
  });

  describe('git for hosted repositories (issue 60)', () => {
    async function gitCheck(output: string, exitCode = 0): Promise<{ check?: Check; git: string }> {
      const bin = tempDir();
      writeFakeGit(bin, output, exitCode);
      vi.stubEnv('PATH', bin);
      const { code, checks } = await runDoctor(await initialisedDataDir());
      expect(code).toBe(ExitCode.Ok);
      return { check: find(checks, 'git'), git: join(bin, 'git') };
    }

    it.each([
      'git version 2.44.0',
      'git version 2.53.0 (Apple Git-154)',
      'git version 2.45.1.windows.1',
      'git version 3.0.0',
    ])('accepts %s', async (output) => {
      const { check, git } = await gitCheck(output);
      expect(check).toEqual({
        name: 'git',
        status: 'ok',
        detail: `${output} (${git}); hosted repositories: yes`,
      });
    });

    it.each(['git version 2.43.7', 'git version 1.99.0'])('warns about %s', async (output) => {
      const { check, git } = await gitCheck(output);
      expect(check).toEqual({
        name: 'git',
        status: 'warn',
        detail: `${output} (${git}); hosted repositories: no (git 2.44 or newer required)`,
        hint: 'Update git to 2.44 or newer to register GitHub repositories; local repositories are not affected.',
      });
    });

    it('warns when the version cannot be read or parsed', async () => {
      const failed = await gitCheck('git version 2.53.0', 1);
      expect(failed.check).toMatchObject({
        status: 'warn',
        detail: `version unknown (${failed.git}); hosted repositories: no (git 2.44 or newer required)`,
      });
      const odd = await gitCheck('something else 2.53.0');
      expect(odd.check).toMatchObject({
        status: 'warn',
        detail: `something else 2.53.0 (${odd.git}); hosted repositories: no (git 2.44 or newer required)`,
      });
    });

    it('warns when git is not on PATH', async () => {
      vi.stubEnv('PATH', tempDir());
      const { code, checks } = await runDoctor(await initialisedDataDir());
      expect(code).toBe(ExitCode.Ok);
      expect(find(checks, 'git')).toEqual({
        name: 'git',
        status: 'warn',
        detail: 'git not found on PATH; hosted repositories: no',
        hint: 'Install git 2.44 or newer to register repositories.',
      });
    });

    it('reports a readable CA bundle without printing its path or contents', async () => {
      const bundle = join(tempDir(), 'planted-ca-bundle.pem');
      actualFs.writeFileSync(bundle, 'PLANTED-CA-CONTENTS');
      vi.stubEnv('GIT_SSL_CAINFO', bundle);
      const { code, checks, lines } = await runDoctor(await initialisedDataDir());
      expect(code).toBe(ExitCode.Ok);
      expect(find(checks, 'git:ca-bundle')).toEqual({
        name: 'git:ca-bundle',
        status: 'ok',
        detail: 'GIT_SSL_CAINFO is set and resolves to a readable regular file',
      });
      expect(lines.join('\n')).not.toMatch(/planted-ca-bundle|PLANTED-CA-CONTENTS/);
    });

    it.each([
      ['a relative path', () => 'ca.pem', 'not an absolute path'],
      ['a directory', () => tempDir(), 'not a regular file'],
      ['a missing file', () => join(tempDir(), 'missing.pem'), 'ENOENT'],
    ])('warns when GIT_SSL_CAINFO is %s, naming only the variable', async (_, value, reason) => {
      const path = value();
      vi.stubEnv('GIT_SSL_CAINFO', path);
      const { code, lines } = await runDoctor(await initialisedDataDir(), false);
      expect(code).toBe(ExitCode.Ok);
      const index = lines.findIndex((l) => l.startsWith('warn  git:ca-bundle'));
      expect(lines[index]).toBe(
        `warn  git:ca-bundle      hosted repositories: no. GIT_SSL_CAINFO must be the absolute path of a readable CA bundle file (${reason}). Fix or unset it to reach GitHub repositories.`,
      );
      expect(lines[index + 1]).toBe(
        "      → Every hosted git step is refused while GIT_SSL_CAINFO is invalid; unset it to use git's default CA bundle.",
      );
      expect(lines.join('\n')).not.toContain(path);
    });
  });

  it('warns when Claude Code is installed but no auth mode is ready', async () => {
    const bin = tempDir();
    actualFs.writeFileSync(
      join(bin, 'claude'),
      fakeClaudeScript('2.1.302 (Claude Code)', `echo '{"loggedIn":false}'; exit 1`),
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', bin);
    const { checks } = await runDoctor(await initialisedDataDir());
    expect(checks.filter((c) => c.name.startsWith('agent:claude-code'))).toEqual([
      {
        name: 'agent:claude-code',
        status: 'ok',
        detail:
          'Claude Code found (2.1.302 (Claude Code)); runs benchmarks with `directivebench benchmark run`',
      },
      {
        name: 'agent:claude-code:subscription',
        status: 'warn',
        detail:
          'not ready (auth-missing): Not logged in: run `claude` and `/login`, or use API key mode.',
        hint: SUBSCRIPTION_LOGIN_HINT,
      },
      {
        name: 'agent:claude-code:api-key',
        status: 'warn',
        detail:
          "not ready (auth-missing): ANTHROPIC_API_KEY is not set (or empty) in this process's environment.",
        hint: API_KEY_HINT,
      },
    ]);
  });

  // Issue 204: every readiness warning names the next step (SPEC-009 §4), in both output forms.
  it('prints a remediation hint under each readiness warning in text form', async () => {
    const bin = tempDir();
    actualFs.writeFileSync(
      join(bin, 'claude'),
      fakeClaudeScript('2.1.302 (Claude Code)', `echo '{"loggedIn":false}'; exit 1`),
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', bin);
    const { lines } = await runDoctor(await initialisedDataDir(), false);
    const subscription = lines.findIndex((l) =>
      l.startsWith('warn  agent:claude-code:subscription'),
    );
    expect(lines[subscription + 1]).toBe(`      → ${SUBSCRIPTION_LOGIN_HINT}`);
    const apiKey = lines.findIndex((l) => l.startsWith('warn  agent:claude-code:api-key'));
    expect(lines[apiKey + 1]).toBe(`      → ${API_KEY_HINT}`);
  });

  it.each([
    {
      code: 'auth-expired',
      version: '2.1.302 (Claude Code)',
      auth: `echo 'Login expired · Please run /login'; exit 1`,
      hint: 'Run `claude` and `/login` to renew the expired login, or set ANTHROPIC_API_KEY to use API key mode.',
    },
    {
      code: 'auth-mismatch',
      version: '2.1.302 (Claude Code)',
      auth: `echo '{"loggedIn":true,"authMethod":"api_key_helper"}'`,
      hint: 'Run `claude` and `/login` with a Claude subscription account (not an API key or key helper), or set ANTHROPIC_API_KEY to use API key mode.',
    },
    {
      code: 'version-unsupported',
      version: 'not a version',
      auth: 'exit 1',
      hint: 'Update Claude Code to 2.1.259 or newer, then run `directivebench doctor` again.',
    },
  ])(
    'gives the subscription check a $code hint when no mode is ready',
    async ({ code, version, auth, hint }) => {
      const bin = tempDir();
      actualFs.writeFileSync(join(bin, 'claude'), fakeClaudeScript(version, auth), {
        mode: 0o755,
      });
      vi.stubEnv('PATH', bin);
      const { checks } = await runDoctor(await initialisedDataDir());
      expect(find(checks, 'agent:claude-code:subscription')).toMatchObject({
        status: 'warn',
        detail: expect.stringContaining(`not ready (${code})`),
        hint,
      });
      const warnings = checks.filter((c) => c.status !== 'ok');
      expect(warnings.every((c) => c.hint)).toBe(true);
    },
  );

  // `auth-missing` also stands for a probe that gave no readable status and for a key that is set
  // but unusable; the hint must fit those details too and never echo the key.
  it('gives probe failures and an unusable API key a hint that fits them', async () => {
    const plantedKey = 'sk-ant-planted-multiline-key-0123456789\nsecond-line';
    vi.stubEnv('ANTHROPIC_API_KEY', plantedKey);
    const bin = tempDir();
    actualFs.writeFileSync(
      join(bin, 'claude'),
      fakeClaudeScript('2.1.302 (Claude Code)', `echo 'unexpected output'; exit 3`),
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', bin);
    const { checks, lines } = await runDoctor(await initialisedDataDir());
    expect(find(checks, 'agent:claude-code:subscription')).toMatchObject({
      status: 'warn',
      detail:
        'not ready (auth-missing): Login not confirmed: `claude auth status` gave no readable status (exit 3).',
      hint: SUBSCRIPTION_LOGIN_HINT,
    });
    expect(find(checks, 'agent:claude-code:api-key')).toMatchObject({
      status: 'warn',
      detail:
        'not ready (auth-missing): API Key Mode needs an ANTHROPIC_API_KEY of at least 8 characters on one line.',
      hint: API_KEY_HINT,
    });
    const output = lines.join('\n');
    expect(output).not.toContain('sk-ant-planted-multiline-key');
    expect(output).not.toContain('second-line');
  });

  describe('agentReadinessHint (issue 204)', () => {
    // A Record over the union fails to type-check when SPEC-203 §9 gains a code without a hint row.
    const codes = Object.keys({
      'binary-not-found': true,
      'version-unsupported': true,
      'auth-missing': true,
      'auth-expired': true,
      'auth-mismatch': true,
    } satisfies Record<ClaudeReadinessCode, true>) as ClaudeReadinessCode[];

    it.each(codes.flatMap((code) => ['subscription', 'api-key'].map((mode) => ({ code, mode }))))(
      'has a hint for $code in $mode mode that names no secret',
      ({ code, mode }) => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-planted-hint-key-0123456789');
        const hint = agentReadinessHint('claude-code', { mode, ready: false, code, detail: '' });
        expect(hint).not.toBe(GENERIC_HINT);
        expect(hint.length).toBeGreaterThan(0);
        expect(hint).not.toContain('sk-ant-planted-hint-key-0123456789');
      },
    );

    it('names installing Claude Code when the binary is missing', () => {
      expect(
        agentReadinessHint('claude-code', {
          mode: 'subscription',
          ready: false,
          code: 'binary-not-found',
          detail: '',
        }),
      ).toBe('Install Claude Code and make sure `claude` is on PATH.');
    });

    it('falls back to a generic hint for another agent or an unknown code', () => {
      const readiness = { mode: 'subscription', ready: false, code: 'auth-missing', detail: '' };
      expect(agentReadinessHint('codex', readiness)).toBe(GENERIC_HINT);
      expect(agentReadinessHint('claude-code', { ...readiness, code: 'something-new' })).toBe(
        GENERIC_HINT,
      );
      expect(agentReadinessHint('claude-code', { ...readiness, code: null })).toBe(GENERIC_HINT);
    });
  });

  it('reports an unsupported version for every mode and never prints the API key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-planted-doctor-key');
    const bin = tempDir();
    actualFs.writeFileSync(join(bin, 'claude'), fakeClaudeScript('2.1.0 (Claude Code)', 'exit 1'), {
      mode: 0o755,
    });
    vi.stubEnv('PATH', bin);
    const { checks, lines } = await runDoctor(await initialisedDataDir());
    expect(find(checks, 'agent:claude-code:api-key')).toEqual({
      name: 'agent:claude-code:api-key',
      status: 'warn',
      detail:
        'not ready (version-unsupported): Claude Code 2.1.0 is older than the minimum 2.1.259; update it.',
      hint: 'Update Claude Code to 2.1.259 or newer, then run `directivebench doctor` again.',
    });
    expect(lines.join('\n')).not.toContain('sk-ant-planted-doctor-key');
  });

  it('prints no readiness lines for an agent that is not installed', async () => {
    vi.stubEnv('PATH', tempDir());
    const { checks } = await runDoctor(await initialisedDataDir());
    expect(checks.filter((c) => c.name.startsWith('agent:')).map((c) => c.name)).toEqual([
      'agent:claude-code',
      'agent:codex',
      'agent:cursor',
    ]);
  });

  it('prints hints under failing checks in text form', async () => {
    restoreNode = fakeNodeVersion('20.0.0');
    const { code, lines } = await runDoctor(join(tempDir(), 'new'), false);
    expect(code).toBe(ExitCode.CheckFailed);
    const index = lines.findIndex((l) => l.startsWith('fail  node'));
    expect(lines[index]).toBe('fail  node               Node.js 20.0.0 (requires >= 22.16.0)');
    expect(lines[index + 1]).toBe(
      '      → Install Node.js 22.16 or newer (Node 24 LTS recommended).',
    );
  });

  it('fails on an unsupported runtime, missing SQLite and an invalid config', async () => {
    restoreNode = fakeNodeVersion('22.15.0');
    vi.mocked(checkSqlite).mockResolvedValue({ ok: false, message: 'node:sqlite unavailable: x' });
    const dataDir = tempDir();
    actualFs.writeFileSync(join(dataDir, 'config.json'), '{"server":{"port":"x"}}');

    const { code, checks } = await runDoctor(dataDir);

    expect(code).toBe(ExitCode.CheckFailed);
    expect(find(checks, 'node')).toMatchObject({ status: 'fail', hint: expect.any(String) });
    expect(find(checks, 'sqlite')).toEqual({
      name: 'sqlite',
      status: 'fail',
      detail: 'node:sqlite unavailable: x',
      hint: 'Use an official Node.js build >= 22.16; node:sqlite is built in.',
    });
    expect(find(checks, 'config')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('is invalid'),
      hint: `Fix or delete ${join(dataDir, 'config.json')}; defaults are used when it is absent.`,
    });
    // Without a valid config the port cannot be determined, so it is not checked.
    expect(find(checks, 'port')).toBeUndefined();
  });

  it('warns about a source checkout without a web build and a missing database', async () => {
    const dataDir = tempDir();
    const webDir = tempDir();
    vi.mocked(resolveAssets).mockReturnValue({ ...packagedAssets(), mode: 'source', webDir });
    vi.stubEnv('DIRECTIVEBENCH_PORT', String(await freePort()));

    const { code, checks } = await runDoctor(dataDir);

    expect(code).toBe(ExitCode.Ok);
    expect(find(checks, 'config')).toMatchObject({
      status: 'ok',
      detail: 'defaults (no config.json yet)',
    });
    expect(find(checks, 'web-build')).toMatchObject({
      status: 'warn',
      detail: `source: ${webDir}`,
      hint: expect.stringContaining('pnpm build'),
    });
    expect(find(checks, 'database')).toMatchObject({ status: 'warn', detail: 'not created yet' });
  });

  it('accepts a source checkout whose web app has been built', async () => {
    const webDir = tempDir();
    actualFs.mkdirSync(join(webDir, '.next'));
    actualFs.writeFileSync(join(webDir, '.next', 'BUILD_ID'), 'id');
    vi.mocked(resolveAssets).mockReturnValue({ ...packagedAssets(), mode: 'source', webDir });

    const { checks } = await runDoctor(tempDir());

    expect(find(checks, 'web-build')).toMatchObject({ status: 'ok', detail: `source: ${webDir}` });
  });

  it('warns about pending migrations, including a database that was never migrated', async () => {
    const dataDir = tempDir();
    actualFs.writeFileSync(join(dataDir, 'directivebench.db'), '');

    const { checks } = await runDoctor(dataDir);

    expect(find(checks, 'database')).toMatchObject({
      status: 'warn',
      detail: `0/${migrationCount} migrations applied`,
      hint: 'Run `directivebench init` to apply pending migrations.',
    });
  });

  it('reports a broken installation when the bundled assets cannot be located', async () => {
    vi.mocked(resolveAssets).mockImplementation(() => {
      throw new Error('Cannot locate the bundled web application');
    });

    const { code, checks } = await runDoctor(tempDir());

    expect(code).toBe(ExitCode.CheckFailed);
    expect(find(checks, 'installation')).toEqual({
      name: 'installation',
      status: 'fail',
      detail: 'Cannot locate the bundled web application',
      hint: 'Reinstall DirectiveBench (`npx directivebench@latest`).',
    });
    expect(find(checks, 'web-build')).toBeUndefined();
  });

  it('warns when the configured port is in use', async () => {
    const port = await listen();
    vi.stubEnv('DIRECTIVEBENCH_PORT', String(port));

    const { code, checks } = await runDoctor(tempDir());

    expect(code).toBe(ExitCode.Ok);
    expect(find(checks, 'port')).toMatchObject({
      status: 'warn',
      detail: `127.0.0.1:${port} is in use (another instance running?)`,
      hint: 'Stop the other process or start with --port <port>.',
    });
  });

  it('fails when the configured server options are invalid', async () => {
    vi.stubEnv('DIRECTIVEBENCH_PORT', '99999');

    const { code, checks } = await runDoctor(tempDir());

    expect(code).toBe(ExitCode.CheckFailed);
    expect(find(checks, 'port')).toMatchObject({
      status: 'fail',
      detail: 'Invalid port "99999" (expected 1–65535)',
      hint: expect.stringContaining('DIRECTIVEBENCH_PORT'),
    });
  });

  it('fails when an existing data directory is not writable', async () => {
    const dataDir = tempDir();
    vi.mocked(fs.accessSync).mockImplementation((path, mode) => {
      if (path === dataDir) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      actualFs.accessSync(path, mode);
    });

    const { checks } = await runDoctor(dataDir);

    expect(find(checks, 'data-dir')).toMatchObject({
      status: 'fail',
      detail: `${dataDir} is not writable`,
      hint: expect.stringContaining('--data-dir'),
    });
  });

  it('fails when no ancestor of a missing data directory is writable', async () => {
    const dataDir = join(tempDir(), 'missing', 'data');
    // Every ancestor, even the filesystem root, is reported missing: the search must stop there.
    vi.mocked(fs.existsSync).mockImplementation((path) =>
      dataDir.startsWith(String(path)) ? false : actualFs.existsSync(path),
    );
    vi.mocked(fs.accessSync).mockImplementation((path, mode) => {
      if (path === '/') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      actualFs.accessSync(path, mode);
    });

    const { code, checks } = await runDoctor(dataDir);

    expect(code).toBe(ExitCode.CheckFailed);
    expect(find(checks, 'data-dir')).toEqual({
      name: 'data-dir',
      status: 'fail',
      detail: `${dataDir} cannot be created: / is not writable`,
      hint: 'Choose a writable location with --data-dir / DIRECTIVEBENCH_DATA_DIR.',
    });
  });
});
