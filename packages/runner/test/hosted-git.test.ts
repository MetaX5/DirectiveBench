import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CA_BUNDLE_VARIABLE,
  HOSTED_GIT_TIMEOUTS,
  HTTPS_TRANSPORT,
  NOT_FOUND_OR_NOT_PUBLIC,
  buildHostedGitEnv,
  cacheFailure,
  checkGitVersion,
  classifyRemoteFailure,
  detectDefaultBranch,
  directorySize,
  ensurePrivateDirectory,
  fetchBlobs,
  fetchSnapshot,
  hostedGitArgs,
  isSafeBranchName,
  listSnapshot,
  readBlobs,
  resolveCaBundle,
  type HostedGitContext,
} from '../src/hosted-git';
import { fakeGit, fakeGitCalls, type FakeAnswer } from './support/hosted-fixtures';

// `lstat` stays real but can be made to fail once: git removes temporary files while it runs.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual, lstat: vi.fn(actual.lstat), readdir: vi.fn(actual.readdir) };
});

const posixOnly = it.skipIf(process.platform === 'win32');
const describePosix = describe.skipIf(process.platform === 'win32');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'directivebench-hosted-git-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const LOCATION = 'https://github.com/acme/skills';

describe('buildHostedGitEnv', () => {
  it('builds the environment from an allowlist and redacts proxy values', () => {
    const base = {
      PATH: `/usr/bin:relative:/bin::.`,
      HOME: '/home/you',
      XDG_CONFIG_HOME: '/home/you/.config',
      TZ: 'UTC',
      SystemRoot: 'C:\\Windows',
      HTTPS_PROXY: 'http://user:secret@proxy:3128',
      no_proxy: 'localhost',
      GIT_ASKPASS: '/usr/bin/askpass',
      SSH_ASKPASS: '/usr/bin/askpass',
      GIT_SSL_NO_VERIFY: '1',
      GIT_DIR: '/elsewhere',
      GIT_CONFIG_PARAMETERS: "'credential.helper'='store'",
      GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz',
    };
    const network = buildHostedGitEnv(base, '/data/cache/git-home', 'network', null, null);
    expect(network).toEqual({
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        HOME: '/data/cache/git-home',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CEILING_DIRECTORIES: '/data/cache',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_LFS_SKIP_SMUDGE: '1',
        TZ: 'UTC',
        SystemRoot: 'C:\\Windows',
        HTTPS_PROXY: 'http://user:secret@proxy:3128',
        no_proxy: 'localhost',
      },
      knownSecrets: ['http://user:secret@proxy:3128', 'localhost'],
    });
    const local = buildHostedGitEnv(
      {},
      '/data/cache/git-home',
      'local',
      '/data/cache/repos/r.git',
      null,
    );
    expect(local.env).toMatchObject({
      PATH: '',
      GIT_NO_LAZY_FETCH: '1',
      GIT_DIR: '/data/cache/repos/r.git',
      GIT_CEILING_DIRECTORIES: '/data/cache',
    });
    expect(Object.keys(local.env)).not.toContain('TZ');
  });
});

describe('CA bundle (issue #61)', () => {
  const refused = (reason: string) => ({
    ok: false,
    code: 'git-failed',
    message: `GIT_SSL_CAINFO must be the absolute path of a readable CA bundle file (${reason}). Fix or unset it to reach GitHub repositories.`,
  });

  it('forwards only the canonical path of an explicit CA bundle file, nothing else TLS-related', async () => {
    const bundle = join(dir, 'proxy-ca.pem');
    writeFileSync(bundle, '-----BEGIN CERTIFICATE-----\n');
    symlinkSync(bundle, join(dir, 'link.pem'));
    expect(CA_BUNDLE_VARIABLE).toBe('GIT_SSL_CAINFO');
    expect(await resolveCaBundle({})).toEqual({ ok: true, caBundle: null });
    expect(await resolveCaBundle({ GIT_SSL_CAINFO: join(dir, 'link.pem') })).toEqual({
      ok: true,
      caBundle: realpathSync(bundle),
    });
    const base = {
      GIT_SSL_CAINFO: join(dir, 'link.pem'),
      GIT_SSL_CAPATH: dir,
      GIT_SSL_NO_VERIFY: '1',
      GIT_SSL_CERT: bundle,
      SSL_CERT_FILE: bundle,
      SSL_CERT_DIR: dir,
      NODE_EXTRA_CA_CERTS: bundle,
      CURL_CA_BUNDLE: bundle,
    };
    const { env } = buildHostedGitEnv(
      base,
      '/data/cache/git-home',
      'network',
      null,
      '/ca/real.pem',
    );
    expect(env.GIT_SSL_CAINFO).toBe('/ca/real.pem');
    expect(Object.keys(env).filter((name) => /SSL|CERT|CA_/.test(name))).toEqual([
      'GIT_SSL_CAINFO',
    ]);
    expect(
      Object.keys(buildHostedGitEnv(base, '/h/git-home', 'local', null, null).env),
    ).not.toContain('GIT_SSL_CAINFO');
  });

  it('fails closed on a CA bundle setting that is not an absolute path to a regular file', async () => {
    mkdirSync(join(dir, 'certs'));
    expect(await resolveCaBundle({ GIT_SSL_CAINFO: '' })).toEqual(refused('not an absolute path'));
    expect(await resolveCaBundle({ GIT_SSL_CAINFO: 'ca.pem' })).toEqual(
      refused('not an absolute path'),
    );
    expect(await resolveCaBundle({ GIT_SSL_CAINFO: join(dir, 'certs') })).toEqual(
      refused('not a regular file'),
    );
    expect(await resolveCaBundle({ GIT_SSL_CAINFO: join(dir, 'missing.pem') })).toEqual(
      refused('ENOENT'),
    );
    symlinkSync(join(dir, 'missing.pem'), join(dir, 'dangling.pem'));
    expect(await resolveCaBundle({ GIT_SSL_CAINFO: join(dir, 'dangling.pem') })).toEqual(
      refused('ENOENT'),
    );
  });

  posixOnly('refuses a FIFO or an unreadable file as CA bundle', async () => {
    execFileSync('mkfifo', [join(dir, 'fifo.pem')]);
    expect(await resolveCaBundle({ GIT_SSL_CAINFO: join(dir, 'fifo.pem') })).toEqual(
      refused('not a regular file'),
    );
    // root reads every file, so the permission case only holds for other users.
    if (process.getuid?.() === 0) return;
    writeFileSync(join(dir, 'secret.pem'), 'x');
    chmodSync(join(dir, 'secret.pem'), 0o000);
    expect(await resolveCaBundle({ GIT_SSL_CAINFO: join(dir, 'secret.pem') })).toEqual(
      refused('EACCES'),
    );
  });
});

describe('hostedGitArgs', () => {
  it('prefixes the hardening configuration with exactly one allowed protocol', () => {
    expect(hostedGitArgs('https', ['ls-remote'])).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'credential.helper=',
      '-c',
      'credential.interactive=false',
      '-c',
      'submodule.recurse=false',
      '-c',
      'http.followRedirects=false',
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
      'ls-remote',
    ]);
    expect(hostedGitArgs('file', [])).toContain('protocol.file.allow=always');
    expect(hostedGitArgs('https', []).join(' ')).not.toMatch(/sslVerify|SSL_NO_VERIFY/);
  });
});

describe('classifyRemoteFailure', () => {
  // Recorded from git 2.53 against github.com with the hardened invocation (2026-10-20).
  it.each([
    ['fatal: unable to get password from user\n', 'auth-required', NOT_FOUND_OR_NOT_PUBLIC],
    [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      'auth-required',
      NOT_FOUND_OR_NOT_PUBLIC,
    ],
    [
      "remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found\n",
      'auth-required',
      NOT_FOUND_OR_NOT_PUBLIC,
    ],
    [
      "fatal: unable to access 'https://github.com/a/b/': The requested URL returned error: 404\n",
      'auth-required',
      NOT_FOUND_OR_NOT_PUBLIC,
    ],
    [
      "fatal: unable to access 'https://github.com/a/b/': The requested URL returned error: 403\n",
      'unreachable',
      'github.com refused the request (HTTP 403, for example a rate limit). Try again later.',
    ],
    [
      "fatal: unable to access 'https://github.com/a/b/': The requested URL returned error: 301\n",
      'invalid-url',
      'The repository URL redirects elsewhere (it was probably renamed or moved). Register its new URL.',
    ],
    [
      "warning: redirecting\nfatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com\n",
      'unreachable',
      "Could not reach github.com: unable to access 'https://github.com/a/b/': Could not resolve host: github.com. Check the network connection or proxy.",
    ],
    [
      'error: SSL certificate problem: unable to get local issuer certificate\n',
      'unreachable',
      'Could not reach github.com: SSL certificate problem: unable to get local issuer certificate. Check the network connection or proxy.',
    ],
    [
      'fatal: the remote end hung up unexpectedly\n',
      'git-failed',
      'git failed: the remote end hung up unexpectedly',
    ],
    ['warning: only a warning\n\n', 'git-failed', 'git failed: no message'],
  ])('maps %j', (stderr, code, message) => {
    expect(classifyRemoteFailure(stderr, 'github.com')).toEqual({ ok: false, code, message });
  });
});

describe('isSafeBranchName', () => {
  it.each(['main', 'release/2.0', 'feature/a_b-c', 'v1.2'])('accepts %s', (name) => {
    expect(isSafeBranchName(name)).toBe(true);
  });
  it.each([
    '-main',
    'a..b',
    'a/.hidden',
    '.main',
    'main.lock',
    'a//b',
    'a/',
    'with space',
    'ünicode',
    'a~1',
    'x'.repeat(256),
  ])('rejects %j', (name) => {
    expect(isSafeBranchName(name)).toBe(false);
  });
});

describe('directorySize and ensurePrivateDirectory', () => {
  it('sums the regular files below a directory, 0 when it is absent', async () => {
    writeFileSync(join(dir, 'a'), Buffer.alloc(10));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b'), Buffer.alloc(5));
    expect(await directorySize(dir)).toBe(15);
    expect(await directorySize(join(dir, 'missing'))).toBe(0);
    await expect(directorySize(join(dir, 'a'))).rejects.toMatchObject({ code: 'ENOTDIR' });
    // A file removed between the listing and its `lstat` takes no space.
    vi.mocked(fsPromises.lstat).mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'ENOENT' }),
    );
    expect(await directorySize(join(dir, 'sub'))).toBe(0);
    // Any other error cannot vouch for the size: it is thrown (fail closed).
    vi.mocked(fsPromises.lstat).mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    );
    await expect(directorySize(join(dir, 'sub'))).rejects.toMatchObject({ code: 'EACCES' });
  });

  posixOnly('creates or tightens a directory to user-only permissions', async () => {
    const existing = join(dir, 'open');
    mkdirSync(existing, { mode: 0o755 });
    chmodSync(existing, 0o755);
    await ensurePrivateDirectory(existing);
    await ensurePrivateDirectory(join(dir, 'new', 'nested'));
    expect(statSync(existing).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'new', 'nested')).mode & 0o777).toBe(0o700);
  });
});

/** A context whose git is a fake answering from `answers`. */
function fakeContext(
  answers: Record<string, FakeAnswer | FakeAnswer[]>,
  overrides: Partial<HostedGitContext> = {},
) {
  const git = fakeGit(join(dir, 'bin'), answers);
  mkdirSync(join(dir, 'git-home'), { recursive: true });
  const context: HostedGitContext = {
    git,
    env: { PATH: process.env.PATH },
    home: join(dir, 'git-home'),
    caBundle: null,
    transport: HTTPS_TRANSPORT,
    signal: new AbortController().signal,
    timeouts: HOSTED_GIT_TIMEOUTS,
    cacheLimitBytes: 1024 * 1024,
    // Far beyond any fake run, so only the checks after a download can see the size.
    cacheSizePollIntervalMs: 10 * 60_000,
    ...overrides,
  };
  return { git, context };
}

describePosix('hosted git steps with a fake git', () => {
  it('checks the version: newer majors pass, garbage and old versions do not', async () => {
    for (const [stdout, ok] of [
      ['git version 3.0.0\n', true],
      ['git version 2.44.0.windows.1\n', true],
      ['git version 2.43.7 (Apple Git-154)\n', false],
      ['nonsense\n', false],
    ] as const) {
      rmSync(join(dir, 'bin'), { recursive: true, force: true });
      const { context } = fakeContext({ version: { stdout } });
      const result = await checkGitVersion(context);
      expect(result === null).toBe(ok);
      if (!ok) expect(result).toMatchObject({ code: 'git-too-old' });
    }
  });

  it('reports a git that times out or cannot be started', async () => {
    const { context } = fakeContext({ version: { sleepMs: 5_000 } });
    expect(
      await checkGitVersion({ ...context, timeouts: { ...context.timeouts, version: 50 } }),
    ).toEqual({
      ok: false,
      code: 'timeout',
      message: 'git version did not finish within the time limit.',
    });
    expect(await checkGitVersion({ ...context, git: join(dir, 'missing-git') })).toEqual({
      ok: false,
      code: 'git-failed',
      message: 'git version failed: git could not be started (ENOENT).',
    });
  });

  it('runs ls-remote with the location after `--` and drops an unsafe default branch', async () => {
    const { git, context } = fakeContext({
      'ls-remote': { stdout: `ref: refs/heads/-x\tHEAD\n${OID_A}\tHEAD\n` },
    });
    expect(await detectDefaultBranch(context, LOCATION)).toEqual({
      ok: true,
      defaultBranch: null,
    });
    const [call] = fakeGitCalls(git);
    expect(call?.args.slice(-5)).toEqual(['ls-remote', '--symref', '--', LOCATION, 'HEAD']);
    expect(call?.env).not.toHaveProperty('GIT_NO_LAZY_FETCH');
    expect(call?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' });
  });

  it('never names the CA bundle path in a message', async () => {
    const { context } = fakeContext(
      {
        'ls-remote': {
          exit: 128,
          stderr:
            "fatal: unable to access 'https://github.com/acme/skills/': error setting certificate file: /etc/ca/proxy.pem\n",
        },
      },
      { caBundle: '/etc/ca/proxy.pem' },
    );
    expect(await detectDefaultBranch(context, LOCATION)).toEqual({
      ok: false,
      code: 'unreachable',
      message:
        "Could not reach github.com: unable to access 'https://github.com/acme/skills/': error setting certificate file: <CA bundle>. Check the network connection or proxy.",
    });
  });

  it('reports output beyond what is read', async () => {
    const { context } = fakeContext({ 'ls-remote': { stdout: Buffer.alloc(2 * 1024 * 1024) } });
    expect(await detectDefaultBranch(context, LOCATION)).toEqual({
      ok: false,
      code: 'git-failed',
      message: 'git ls-remote printed more output than DirectiveBench reads.',
    });
  });

  it('fails a clone whose commit cannot be read, or whose cache exceeds the limit afterwards', async () => {
    const cacheDir = join(dir, 'repos', 'repo_x.git');
    const target = { location: LOCATION, branch: 'main', cacheDir };
    mkdirSync(join(dir, 'repos'));
    let { context } = fakeContext({ clone: { creates: { HEAD: 1 } }, 'rev-parse': { exit: 128 } });
    expect(await fetchSnapshot(context, target)).toEqual({
      ok: false,
      code: 'git-failed',
      message: 'The fetched commit could not be read from the cache.',
    });
    rmSync(join(dir, 'bin'), { recursive: true, force: true });
    ({ context } = fakeContext({ clone: { creates: { 'objects/pack': 2 * 1024 * 1024 } } }));
    expect(await fetchSnapshot(context, target)).toMatchObject({
      ok: false,
      code: 'cache-limit-exceeded',
    });
    rmSync(join(dir, 'bin'), { recursive: true, force: true });
    ({ context } = fakeContext({
      clone: { creates: { HEAD: 1 } },
      'rev-parse': { stdout: 'not-an-object-id\n' },
    }));
    expect(await fetchSnapshot(context, target)).toMatchObject({ ok: false, code: 'git-failed' });
  });

  it('kills a download as soon as the cache it fills exceeds the limit', async () => {
    const cacheDir = join(dir, 'repos', 'repo_x.git');
    mkdirSync(join(dir, 'repos'));
    // The fake writes past the limit and then keeps running; only the size watch can stop it.
    const { context } = fakeContext(
      { clone: { creates: { 'objects/pack': 2 * 1024 * 1024 }, sleepMs: 30_000 } },
      { cacheSizePollIntervalMs: 5 },
    );
    const started = Date.now();
    const result = await fetchSnapshot(context, {
      location: LOCATION,
      branch: 'main',
      cacheDir,
    });
    expect(result).toMatchObject({ ok: false, code: 'cache-limit-exceeded' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('throws a size check that fails during a download, after stopping git', async () => {
    const cacheDir = join(dir, 'repos', 'repo_x.git');
    mkdirSync(join(dir, 'repos'));
    const { context } = fakeContext(
      { clone: { creates: { HEAD: 1 }, sleepMs: 30_000 } },
      { cacheSizePollIntervalMs: 5 },
    );
    const denied = Object.assign(new Error(`EACCES: permission denied, scandir '${cacheDir}'`), {
      code: 'EACCES',
    });
    vi.mocked(fsPromises.readdir).mockRejectedValueOnce(denied);
    const started = Date.now();
    // Thrown, so the scan reports it as a cache failure (cacheFailure) instead of git's error.
    await expect(
      fetchSnapshot(context, { location: LOCATION, branch: 'main', cacheDir }),
    ).rejects.toBe(denied);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('fails closed when the cache cannot be checked or deleted', async () => {
    const cacheDir = join(dir, 'repos', 'repo_x.git');
    const target = { location: LOCATION, branch: 'main', cacheDir };
    const denied = Object.assign(new Error(`EACCES: permission denied, lstat '${cacheDir}'`), {
      code: 'EACCES',
    });
    const { git, context } = fakeContext({ clone: { creates: { HEAD: 1 } } });
    // An lstat that fails for another reason than absence is not "absent: clone".
    vi.mocked(fsPromises.lstat).mockRejectedValueOnce(denied);
    await expect(fetchSnapshot(context, target)).rejects.toBe(denied);
    expect(fakeGitCalls(git)).toEqual([]);
  });

  it('names a fixed cause and only the error code for a cache that cannot be used', () => {
    const message = (code: string) =>
      `DirectiveBench could not use its cache of hosted repositories in the data directory (${code}). Check that the data directory is writable and the disk has free space.`;
    expect(
      cacheFailure(
        Object.assign(new Error("ENOSPC: no space left, write '/data/x'"), { code: 'ENOSPC' }),
      ),
    ).toEqual({ ok: false, code: 'git-failed', message: message('ENOSPC') });
    for (const error of [new Error('/data/cache'), null, 'text', { code: 'not a code /data' }]) {
      expect(cacheFailure(error).message).toBe(message('unknown error'));
    }
  });

  it('fails closed on tree entries it does not understand', async () => {
    for (const record of [
      `100664 blob ${OID_A}\tAGENTS.md`,
      `160000 blob ${OID_A}\tsub`,
      `100644 commit ${OID_A}\tsub`,
      'garbage',
    ]) {
      rmSync(join(dir, 'bin'), { recursive: true, force: true });
      const { context } = fakeContext({ 'ls-tree': { stdout: `${record}\0` } });
      expect(await listSnapshot(context, dir, OID_B)).toMatchObject({
        ok: false,
        code: 'git-failed',
      });
    }
    rmSync(join(dir, 'bin'), { recursive: true, force: true });
    const slow = fakeContext(
      { 'ls-tree': { sleepMs: 5_000 } },
      { timeouts: { ...HOSTED_GIT_TIMEOUTS, read: 100 } },
    );
    expect(await listSnapshot(slow.context, dir, OID_B)).toMatchObject({ code: 'timeout' });
    rmSync(join(dir, 'bin'), { recursive: true, force: true });
    const { context } = fakeContext({
      'ls-tree': {
        exit: 128,
        stderr: `fatal: not a tree object in ${join(dir, 'repos', 'x.git')}\n`,
      },
    });
    expect(await listSnapshot(context, dir, OID_B)).toEqual({
      ok: false,
      code: 'git-failed',
      // The absolute cache location is never part of a message.
      message: 'git ls-tree failed: not a tree object in <cache>/repos/x.git',
    });
  });

  it('fails the blob fetch when the cache cannot be checked, the fetch or the limit fails, or blobs stay missing', async () => {
    const target = { cacheDir: dir, location: LOCATION };
    const missing = { stdout: `${OID_A} missing\n` };
    const cases: [Record<string, FakeAnswer | FakeAnswer[]>, string, number?][] = [
      [{ 'cat-file': { exit: 128, stderr: 'fatal: bad object\n' } }, 'git-failed'],
      [{ 'cat-file': { sleepMs: 5_000 } }, 'timeout'],
      [
        { 'cat-file': missing, fetch: { exit: 128, stderr: 'remote: Repository not found.\n' } },
        'auth-required',
      ],
      [{ 'cat-file': [missing, { exit: 128 }], fetch: {} }, 'git-failed'],
      [{ 'cat-file': missing, fetch: {} }, 'git-failed'],
      [{ 'cat-file': missing, fetch: {} }, 'cache-limit-exceeded', 1],
      [{ 'cat-file': missing, fetch: { sleepMs: 5_000 } }, 'timeout'],
    ];
    for (const [answers, code, limit] of cases) {
      rmSync(join(dir, 'bin'), { recursive: true, force: true });
      const { context } = fakeContext(answers, {
        timeouts: { ...HOSTED_GIT_TIMEOUTS, read: 200, fetch: 200 },
        ...(limit === undefined ? {} : { cacheLimitBytes: limit }),
      });
      expect(await fetchBlobs(context, target, [OID_A])).toMatchObject({ ok: false, code });
    }
    rmSync(join(dir, 'bin'), { recursive: true, force: true });
    const { context } = fakeContext({ 'cat-file': missing, fetch: {} });
    expect(await fetchBlobs(context, target, [OID_A])).toEqual({
      ok: false,
      code: 'git-failed',
      message: 'The repository did not send every requested file.',
    });
  });

  it('fails reading blobs whose output is not what was asked for', async () => {
    const blobs = new Map([[OID_A, 3]]);
    for (const answer of [
      { exit: 128, stderr: 'fatal: bad\n' },
      { sleepMs: 5_000 },
      { stdout: `${OID_B} blob 3\nabc\n` },
      { stdout: `${OID_A} blob 3\nab` },
      { stdout: '' },
    ]) {
      rmSync(join(dir, 'bin'), { recursive: true, force: true });
      const { context } = fakeContext(
        { 'cat-file': answer },
        { timeouts: { ...HOSTED_GIT_TIMEOUTS, read: 200 } },
      );
      expect(await readBlobs(context, dir, blobs)).toMatchObject({ ok: false });
    }
  });
});
