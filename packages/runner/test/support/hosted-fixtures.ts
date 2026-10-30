import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HostedGitTransport } from '../../src/hosted-git';

/** Fixture git commands ignore the developer's system and global config. */
export const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

export function git(cwd: string, args: string[], input?: string | Buffer): string {
  return execFileSync('git', args, { cwd, env: FIXTURE_GIT_ENV, input }).toString();
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), content);
  }
}

/**
 * A local stand-in for a GitHub repository: a work tree whose commits are pushed to the bare
 * repository `<remotes>/<owner>/<repo>.git`, which serves partial clones like GitHub does
 * (`uploadpack.allowFilter`). Tests reach it through {@link fileTransport}, never the network.
 */
export class FixtureRemote {
  readonly work: string;
  readonly bare: string;

  constructor(
    remotes: string,
    readonly owner: string,
    readonly repo: string,
    files: Record<string, string | Buffer> = {},
  ) {
    this.work = join(remotes, '.work', owner, repo);
    this.bare = join(remotes, owner, `${repo}.git`);
    mkdirSync(this.work, { recursive: true });
    git(this.work, ['init', '-q', '-b', 'main']);
    mkdirSync(this.bare, { recursive: true });
    git(this.bare, ['init', '-q', '--bare', '-b', 'main']);
    git(this.bare, ['config', 'uploadpack.allowFilter', 'true']);
    git(this.work, ['remote', 'add', 'origin', this.bare]);
    if (Object.keys(files).length > 0) this.commit(files);
  }

  get location(): string {
    return `https://github.com/${this.owner}/${this.repo}`;
  }

  /** Writes the files, commits everything and pushes; returns the new commit. */
  commit(files: Record<string, string | Buffer>, message = 'change'): string {
    writeFiles(this.work, files);
    git(this.work, ['add', '-A']);
    git(this.work, ['commit', '-q', '--allow-empty', '-m', message]);
    git(this.work, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    return this.head();
  }

  /**
   * Commits a file whose name is raw bytes through the index alone, so the name never has to
   * exist on disk: APFS (macOS) and NTFS reject names that are not valid UTF-8 (issue #120).
   */
  commitRawPath(path: Buffer, content: string, message = 'raw path'): string {
    const blob = git(this.work, ['hash-object', '-w', '--stdin'], content).trim();
    const entry = Buffer.concat([Buffer.from(`100644 ${blob}\t`), path, Buffer.from('\n')]);
    git(this.work, ['update-index', '--add', '--index-info'], entry);
    git(this.work, ['commit', '-q', '-m', message]);
    git(this.work, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    return this.head();
  }

  head(): string {
    return git(this.bare, ['rev-parse', 'refs/heads/main']).trim();
  }

  /** The blob ID of a path at the remote's head. */
  blob(path: string): string {
    return git(this.bare, ['rev-parse', `refs/heads/main:${path}`]).trim();
  }
}

/** Maps `https://github.com/<owner>/<repo>` to `<remotes>/<owner>/<repo>.git` over `file://`. */
export function fileTransport(remotes: string): HostedGitTransport {
  return {
    remoteUrl: (location) => {
      const [owner, repo] = new URL(location).pathname.slice(1).split('/');
      return pathToFileURL(join(remotes, String(owner), `${String(repo)}.git`)).href;
    },
    protocol: 'file',
  };
}

/** Every object in a repository's object store (`cat-file --batch-all-objects`), by type. */
export function objectsIn(repository: string): { oid: string; type: string; size: number }[] {
  const listing = execFileSync('git', ['cat-file', '--batch-all-objects', '--batch-check'], {
    cwd: repository,
    env: { ...FIXTURE_GIT_ENV, GIT_NO_LAZY_FETCH: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
  return listing
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [oid = '', type = '', size = '0'] = line.split(' ');
      return { oid, type, size: Number(size) };
    });
}

export interface FakeAnswer {
  stdout?: Buffer | string;
  stderr?: string;
  exit?: number;
  sleepMs?: number;
  /** Files (relative path → size in bytes) created below the last argument, like a clone. */
  creates?: Record<string, number>;
}

/**
 * A fake git for the branches real git cannot reach: a Node script that answers each subcommand
 * (the first argument after the `-c` pairs) from `<script>.json`. An array answers successive
 * calls of that subcommand in turn (the last one repeats). Every call is appended to
 * `<script>.log` as JSON (argv, working directory, environment).
 */
export function fakeGit(dir: string, answers: Record<string, FakeAnswer | FakeAnswer[]>): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'git');
  const encode = (answer: FakeAnswer) => ({
    ...answer,
    stdout: Buffer.from(answer.stdout ?? '').toString('base64'),
  });
  const encoded = Object.fromEntries(
    Object.entries(answers).map(([command, answer]) => [
      command,
      Array.isArray(answer) ? answer.map(encode) : [encode(answer)],
    ]),
  );
  writeFileSync(`${script}.json`, JSON.stringify(encoded));
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
let i = 0;
while (args[i] === '-c') i += 2;
const command = args[i];
const log = __filename + '.log';
const previous = fs.existsSync(log)
  ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).map(JSON.parse).filter((call) => call.command === command).length
  : 0;
fs.appendFileSync(log, JSON.stringify({ command, args, cwd: process.cwd(), env: process.env }) + '\\n');
const list = JSON.parse(fs.readFileSync(__filename + '.json', 'utf8'))[command] ?? [{ exit: 99, stderr: 'unexpected ' + command }];
const answer = list[Math.min(previous, list.length - 1)];
for (const [file, size] of Object.entries(answer.creates ?? {})) {
  const target = path.join(args[args.length - 1], file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(size));
}
process.stdin.resume();
process.stdin.on('error', () => undefined);
setTimeout(() => {
  process.stdout.write(Buffer.from(answer.stdout ?? '', 'base64'), () =>
    process.stderr.write(answer.stderr ?? '', () => process.exit(answer.exit ?? 0)),
  );
}, answer.sleepMs ?? 0);
`,
  );
  chmodSync(script, 0o755);
  return script;
}

/** The calls a fake git received. */
export function fakeGitCalls(
  script: string,
): { command: string; args: string[]; cwd: string; env: Record<string, string> }[] {
  const log = `${script}.log`;
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map(
      (line) =>
        JSON.parse(line) as {
          command: string;
          args: string[];
          cwd: string;
          env: Record<string, string>;
        },
    );
}
