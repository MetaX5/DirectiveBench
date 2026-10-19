import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  migrateDatabase,
  openDatabase,
  schema,
  type DatabaseHandle,
} from '@directivebench/database';
import {
  LOCAL_GIT_TIMEOUT_MS,
  RegistrationCancelledError,
  absolutePathEntries,
  buildGitEnv,
  findGitExecutable,
  hardenedGitArgs,
  inspectLocalPath,
  registerLocalPath,
  type LocalPathInspectionOptions,
} from '../src/index';

const migrations = fileURLToPath(new URL('../../database/migrations', import.meta.url));

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** Fixture git commands ignore the developer's system and global config (e.g. commit signing). */
const NO_USER_CONFIG = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

/** Environment of the git commands the tests themselves run to build fixtures. */
const FIXTURE_GIT_ENV = { ...process.env, ...NO_USER_CONFIG, ...GIT_IDENTITY };

let root: string;

beforeEach(() => {
  // realpath: on macOS the temp directory is behind the /var → /private/var symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'directivebench-registration-')));
});

afterEach(() => {
  // Restore permissions changed by a test so the directory can be removed.
  for (const name of readdirSync(root)) chmodSync(join(root, name), 0o755);
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: FIXTURE_GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'AGENTS.md'), '# Rules\n');
  git(dir, 'add', 'AGENTS.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function makeDir(...segments: string[]): string {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function options(overrides: Partial<LocalPathInspectionOptions> = {}): LocalPathInspectionOptions {
  return { homeDir: root, env: process.env, signal: new AbortController().signal, ...overrides };
}

/** A directory whose `git` executable is the given shell script; nothing else is on PATH. */
function fakeGit(script: string): NodeJS.ProcessEnv {
  const bin = makeDir('fake-bin');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { PATH: `${bin}:/usr/bin:/bin` };
}

describe('inspectLocalPath', () => {
  it('registers a path inside a work tree as local-git at its top level with the current branch', async () => {
    const repo = makeRepo('skills');
    const nested = makeDir('skills', 'a', 'b');

    expect(await inspectLocalPath(nested, options())).toEqual({
      ok: true,
      provider: 'local-git',
      location: repo,
      name: 'skills',
      defaultBranch: 'main',
    });
  });

  it('normalises ~, trailing slashes and symlinks to the same location', async () => {
    const repo = makeRepo('skills');
    symlinkSync(repo, join(root, 'link'));

    for (const path of [
      '~/skills/',
      `${repo}/`,
      `${repo}//.git/..`,
      join(root, 'link'),
      '~/link/',
    ]) {
      expect(await inspectLocalPath(path, options()), path).toMatchObject({ location: repo });
    }
  });

  it('registers a directory outside any work tree as local-directory', async () => {
    const dir = makeDir('rules');

    expect(await inspectLocalPath('~/rules', options())).toEqual({
      ok: true,
      provider: 'local-directory',
      location: dir,
      name: 'rules',
      defaultBranch: null,
    });
    expect(await inspectLocalPath('~', options())).toMatchObject({
      provider: 'local-directory',
      location: root,
    });
  });

  it('names the file-system root after its path', async () => {
    expect(await inspectLocalPath('/', options())).toMatchObject({ location: '/', name: '/' });
  });

  it('leaves the branch unknown for a detached HEAD', async () => {
    const repo = makeRepo('skills');
    git(repo, 'checkout', '-q', '--detach');

    expect(await inspectLocalPath(repo, options())).toMatchObject({
      provider: 'local-git',
      defaultBranch: null,
    });
  });

  it('rejects a path inside the git directory', async () => {
    const repo = makeRepo('skills');

    expect(await inspectLocalPath(join(repo, '.git'), options())).toEqual({
      ok: false,
      code: 'git-directory',
      message: 'This path is inside a Git directory (.git) or a bare repository, not a work tree.',
    });
  });

  it('rejects missing paths and files without touching them', async () => {
    writeFileSync(join(root, 'notes.txt'), 'x');
    const missing = {
      ok: false,
      code: 'path-not-found',
      message: 'No directory exists at this path.',
    };

    expect(await inspectLocalPath(join(root, 'nope'), options())).toEqual(missing);
    expect(await inspectLocalPath(join(root, 'notes.txt', 'inner'), options())).toEqual(missing);
    expect(await inspectLocalPath(`/${'a'.repeat(300)}`, options())).toEqual(missing);
    expect(await inspectLocalPath(join(root, 'notes.txt'), options())).toEqual({
      ok: false,
      code: 'not-a-directory',
      message: 'This path is a file, not a directory.',
    });
    expect(existsSync(join(root, 'nope'))).toBe(false);
  });

  it('rejects directories it cannot read or reach (denied paths)', async () => {
    const locked = makeDir('locked');
    makeDir('locked', 'inner');
    chmodSync(locked, 0o000);

    expect(await inspectLocalPath(locked, options())).toEqual({
      ok: false,
      code: 'permission-denied',
      message: 'DirectiveBench cannot read this directory.',
    });
    expect(await inspectLocalPath(join(locked, 'inner'), options())).toEqual({
      ok: false,
      code: 'permission-denied',
      message: 'DirectiveBench cannot access this path.',
    });
  });

  it('fails closed when git is not installed', async () => {
    const dir = makeDir('rules');

    expect(await inspectLocalPath(dir, options({ env: { PATH: makeDir('empty-bin') } }))).toEqual({
      ok: false,
      code: 'git-not-installed',
      message: 'git was not found on PATH.',
    });
  });

  it('never runs a git executable shipped inside the repository (relative PATH entries)', async () => {
    const repo = makeRepo('trojan');
    const marker = join(root, 'trojan-ran');
    for (const name of ['git', 'git.exe']) {
      writeFileSync(join(repo, name), `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`, {
        mode: 0o755,
      });
    }
    const realGitDir = dirname((await findGitExecutable(process.env)) as string);
    // Empty and `.` entries make a bare `git` resolve against the working directory.
    const env = { PATH: ['', '.', realGitDir].join(delimiter), PATHEXT: '.EXE' };

    expect(await inspectLocalPath(repo, options({ env }))).toMatchObject({
      provider: 'local-git',
      location: repo,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('reports a git that cannot be started', async () => {
    const dir = makeDir('rules');
    const env = fakeGit('');
    // A shebang pointing at a missing interpreter makes the spawn itself fail.
    writeFileSync(join(root, 'fake-bin', 'git'), '#!/nonexistent/sh\n', { mode: 0o755 });

    expect(await inspectLocalPath(dir, options({ env }))).toMatchObject({
      ok: false,
      code: 'git-failed',
      message: expect.stringMatching(/^git could not be started: /),
    });
  });

  it('rejects a work tree that core.worktree moves to an ancestor', async () => {
    const repo = makeRepo('nested/proj');
    git(repo, 'config', 'core.worktree', root);

    expect(await inspectLocalPath(repo, options())).toEqual({
      ok: false,
      code: 'git-failed',
      message:
        "git reports a work tree that does not hold this repository's .git (core.worktree points elsewhere).",
    });
  });

  it('fails closed on a broken .git file instead of registering a plain directory', async () => {
    const dir = makeDir('broken');
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/directivebench\n');

    expect(await inspectLocalPath(dir, options())).toMatchObject({
      ok: false,
      code: 'git-failed',
      message: expect.stringMatching(/^git could not inspect this path: not a git repository: /),
    });
  });

  it('resolves .. after following symlinks', async () => {
    const repo = makeRepo('skills');
    makeDir('skills', 'sub');
    symlinkSync(join(repo, 'sub'), join(root, 'link'));

    // Textually `${root}/link/..` is the (non-git) temp root; physically it is the repository.
    expect(await inspectLocalPath(join(root, 'link') + '/..', options())).toMatchObject({
      provider: 'local-git',
      location: repo,
    });
    expect(await inspectLocalPath('~/link/..', options())).toMatchObject({ location: repo });
  });

  it('does not store a branch name that output redaction rewrote', async () => {
    const repo = makeRepo('skills');
    git(repo, 'checkout', '-q', '-b', `feat/ghp_${'a'.repeat(24)}`);

    expect(await inspectLocalPath(repo, options())).toMatchObject({
      provider: 'local-git',
      defaultBranch: null,
    });
  });

  it('fails closed when git does not answer in time', async () => {
    const dir = makeDir('rules');
    const env = fakeGit('exec sleep 5');

    expect(await inspectLocalPath(dir, options({ env, timeoutMs: 100 }))).toEqual({
      ok: false,
      code: 'timeout',
      message: 'git did not answer within 0.1 s.',
    });
    expect(LOCAL_GIT_TIMEOUT_MS).toBe(2000);
  });

  it('fails closed on unexpected git errors and answers', async () => {
    const dir = makeDir('rules');
    const cases: [string, string][] = [
      [
        'echo "fatal: detected dubious ownership" >&2; exit 128',
        'git could not inspect this path: detected dubious ownership',
      ],
      ['exit 3', 'git could not inspect this path: no message'],
      ['echo maybe', 'git returned an unexpected answer for this path.'],
      ['printf "true\\nsub/\\n"', 'git returned an unexpected answer for this path.'],
    ];
    for (const [script, message] of cases) {
      rmSync(join(root, 'fake-bin'), { recursive: true, force: true });
      expect(await inspectLocalPath(dir, options({ env: fakeGit(script) })), script).toEqual({
        ok: false,
        code: 'git-failed',
        message,
      });
    }
  });

  it('rejects a work-tree answer when no .git entry exists at or above the path', async () => {
    const dir = makeDir('rules');
    const env = fakeGit('case "$*" in *rev-parse*) printf "true\\n\\n" ;; esac');

    expect(await inspectLocalPath(dir, options({ env }))).toMatchObject({
      ok: false,
      code: 'git-failed',
    });
  });

  it('accepts a work-tree answer without cdup and an empty branch as unknown', async () => {
    const dir = makeDir('rules');
    makeDir('rules', '.git');
    const env = fakeGit('case "$*" in *rev-parse*) printf true ;; esac');

    expect(await inspectLocalPath(dir, options({ env }))).toEqual({
      ok: true,
      provider: 'local-git',
      location: dir,
      name: 'rules',
      defaultBranch: null,
    });
  });

  it('stops when the job is cancelled before or during the git queries', async () => {
    const dir = makeDir('rules');
    const cancelled = new AbortController();
    cancelled.abort('cancelled');
    await expect(
      inspectLocalPath(dir, options({ signal: cancelled.signal })),
    ).rejects.toBeInstanceOf(RegistrationCancelledError);

    makeDir('rules', '.git');
    const env = fakeGit('case "$*" in *rev-parse*) printf "true\\n\\n" ;; *) exec sleep 5 ;; esac');
    const controller = new AbortController();
    const pending = inspectLocalPath(dir, options({ env, signal: controller.signal }));
    setTimeout(() => controller.abort('cancelled'), 200);
    await expect(pending).rejects.toThrow('Registration was cancelled');
  });
});

describe('read-only guarantee (FR-104-11, FR-104-12)', () => {
  /** Every entry under `dir`, including `.git`, with its type, mode, size, mtime and content. */
  function snapshot(dir: string): Record<string, string> {
    const entries: Record<string, string> = {};
    const walk = (current: string) => {
      for (const name of readdirSync(current)) {
        const path = join(current, name);
        const stat = lstatSync(path);
        const key = relative(dir, path);
        if (stat.isDirectory()) {
          entries[key] = `dir ${stat.mode}`;
          walk(path);
        } else if (stat.isSymbolicLink()) {
          entries[key] = `link ${readlinkSync(path)}`;
        } else {
          const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
          entries[key] = `file ${stat.mode} ${stat.size} ${stat.mtimeMs} ${hash}`;
        }
      }
    };
    walk(dir);
    return entries;
  }

  /**
   * A repository whose own configuration would run code: an fsmonitor command and hooks (both in
   * `core.hooksPath` and `.git/hooks`) that append to a marker file outside the repository.
   */
  function maliciousRepo(): { repo: string; marker: string } {
    const repo = makeRepo('malicious');
    const marker = join(root, 'marker');
    const hooks = makeDir('evil-hooks');
    const payload = (label: string) => `#!/bin/sh\necho "${label}" >> "${marker}"\n`;
    writeFileSync(join(root, 'fsmonitor'), payload('fsmonitor'), { mode: 0o755 });
    for (const hook of [
      'pre-commit',
      'post-index-change',
      'post-checkout',
      'reference-transaction',
    ]) {
      writeFileSync(join(hooks, hook), payload(hook), { mode: 0o755 });
      writeFileSync(join(repo, '.git', 'hooks', hook), payload(hook), { mode: 0o755 });
    }
    git(repo, 'config', 'core.fsmonitor', join(root, 'fsmonitor'));
    git(repo, 'config', 'core.hooksPath', hooks);
    writeFileSync(join(repo, 'untracked.md'), 'changed\n');
    return { repo, marker };
  }

  it('the malicious fixture is armed: plain git status runs its fsmonitor and hooks', () => {
    const { repo, marker } = maliciousRepo();
    git(repo, 'status', '--short');
    const ran = readFileSync(marker, 'utf8');
    expect(ran).toMatch(/fsmonitor/);
    expect(ran).toMatch(/post-index-change/);
  });

  it('registration executes nothing from the repository and modifies no file in it', async () => {
    const { repo, marker } = maliciousRepo();
    const before = snapshot(repo);

    expect(await inspectLocalPath(join(repo, 'sub-path-that-is-missing'), options())).toMatchObject(
      { code: 'path-not-found' },
    );
    expect(await inspectLocalPath(repo, options())).toMatchObject({
      provider: 'local-git',
      location: repo,
      defaultBranch: 'main',
    });

    expect(existsSync(marker)).toBe(false);
    expect(snapshot(repo)).toEqual(before);
  });

  it('the hardening disables fsmonitor and hooks even for commands that would run them', () => {
    const { repo, marker } = maliciousRepo();
    const run = (...args: string[]) =>
      execFileSync('git', hardenedGitArgs(args), {
        cwd: repo,
        env: { ...buildGitEnv(process.env), ...NO_USER_CONFIG, ...GIT_IDENTITY },
        encoding: 'utf8',
      });

    run('status', '--short');
    run('commit', '-q', '--allow-empty', '-m', 'hooks must not run');
    run('checkout', '-q', '--detach');

    expect(existsSync(marker)).toBe(false);
  });
});

describe('git invocation', () => {
  it('prefixes every command with the hardening configuration', () => {
    expect(hardenedGitArgs(['rev-parse', '--show-cdup'])).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.ext.allow=never',
      'rev-parse',
      '--show-cdup',
    ]);
  });

  it('keeps only absolute PATH entries', () => {
    expect(absolutePathEntries(['/usr/bin', '', '.', 'bin', '/bin'].join(delimiter))).toEqual([
      '/usr/bin',
      '/bin',
    ]);
    expect(absolutePathEntries(undefined)).toEqual([]);
    expect(buildGitEnv({}).PATH).toBe('');
  });

  it('finds git only as an executable file on an absolute PATH entry', async () => {
    const dirOnly = makeDir('dir-bin', 'git'); // a directory named git is skipped
    const plain = makeDir('plain-bin');
    writeFileSync(join(plain, 'git'), 'not executable', { mode: 0o644 });
    const real = (await findGitExecutable(process.env)) as string;

    expect(
      await findGitExecutable({ PATH: [dirname(dirOnly), plain, dirname(real)].join(delimiter) }),
    ).toBe(real);
    expect(await findGitExecutable({ PATH: [dirname(dirOnly), plain].join(delimiter) })).toBeNull();
  });

  it('builds the environment from an allowlist plus fixed safety settings', () => {
    const env = buildGitEnv({
      PATH: `/usr/bin${delimiter}${delimiter}.`,
      HOME: '/home/me',
      XDG_CONFIG_HOME: '/home/me/.config',
      GIT_DIR: '/elsewhere/.git',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'",
      GIT_SSH_COMMAND: 'evil',
      GITHUB_TOKEN: 'ghp_secret',
      LANG: 'pl_PL.UTF-8',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      XDG_CONFIG_HOME: '/home/me/.config',
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_NO_LAZY_FETCH: '1',
    });
  });
});

describe('registerLocalPath', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = openDatabase(join(root, 'test.db'));
    await migrateDatabase(handle, migrations);
  });

  afterEach(() => handle.close());

  it('stores the repository once and returns it for every variant of the path', async () => {
    const repo = makeRepo('skills');

    const first = await registerLocalPath(handle.db, `${repo}/`, options());
    expect(first).toEqual({
      ok: true,
      repositoryId: expect.stringMatching(/^repo_/),
      created: true,
    });
    const again = await registerLocalPath(handle.db, '~/skills', options());
    expect(again).toEqual({ ...first, created: false });

    const rows = await handle.db.select().from(schema.repositories);
    expect(rows).toEqual([
      expect.objectContaining({
        provider: 'local-git',
        location: repo,
        name: 'skills',
        defaultBranch: 'main',
        syncStatus: 'never',
      }),
    ]);
  });

  it('stores nothing for a rejected path', async () => {
    expect(await registerLocalPath(handle.db, join(root, 'nope'), options())).toEqual({
      ok: false,
      code: 'path-not-found',
      message: 'No directory exists at this path.',
    });
    expect(await handle.db.$count(schema.repositories)).toBe(0);
  });
});
