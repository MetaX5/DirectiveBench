import { constants } from 'node:fs';
import { access, mkdir, chmod, lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { RepositoryTreeEntry } from '@directivebench/core';
import { errnoCode, runGitProcess, type GitProcessResult } from './git-process';
import { absolutePathEntries } from './repository-registration';

/**
 * How hosted git reaches a repository. Production uses {@link HTTPS_TRANSPORT}: the stored
 * `https://github.com/…` location itself, and HTTPS as the only protocol git may speak. Tests
 * construct a transport that maps the location to a local bare repository and allows `file`
 * instead (SPEC-105 §9.1, "through the same mechanism"); it is an option of `LocalRunner` in code
 * only — no configuration, environment variable or CLI flag reaches it.
 */
export interface HostedGitTransport {
  /** The URL git fetches from for a stored, normalised location. */
  remoteUrl(location: string): string;
  /** The one protocol git may use (`protocol.allow=never` plus this one). */
  protocol: 'https' | 'file';
}

export const HTTPS_TRANSPORT: HostedGitTransport = {
  remoteUrl: (location) => location,
  protocol: 'https',
};

/** `GIT_NO_LAZY_FETCH` exists from git 2.44; older versions would fetch silently on any read. */
export const MIN_HOSTED_GIT_VERSION = { major: 2, minor: 44 } as const;

/** Named timeouts of the hosted steps (SPEC-105 §9.1; NFR-104-01: 30 s for hosted validation). */
export const HOSTED_GIT_TIMEOUTS = {
  /** `git version`. */
  version: 5_000,
  /** `ls-remote` at registration. */
  lsRemote: 30_000,
  /** Clone or fetch of the commit and trees, and the blob fetch. */
  fetch: 5 * 60_000,
  /** Reads from the cache: `rev-parse`, `ls-tree`, `cat-file`. */
  read: 60_000,
  /**
   * All the `cat-file --batch` reads of step 5 of one scan together (SPEC-105 §9.1): each batch
   * also has `read`, so the work cannot grow with the number of batches.
   */
  readTotal: 5 * 60_000,
} as const;

export type HostedGitTimeouts = { [K in keyof typeof HOSTED_GIT_TIMEOUTS]: number };

/** git keeps nothing worth a graceful stop; a stopped git gets SIGKILL after this. */
export const HOSTED_GIT_KILL_GRACE_MS = 1_000;

/**
 * Largest cache of one repository (SPEC-105 §12, default 500 MiB — Assumption). Blob sizes are
 * unknown before download, so the cache is measured while git fetches and git is killed above it.
 */
export const HOSTED_CACHE_LIMIT_BYTES = 500 * 1024 * 1024;

/** How often the cache is measured while git fetches (SPEC-105 §12, `CACHE_SIZE_POLL_INTERVAL_MS`). */
export const CACHE_SIZE_POLL_INTERVAL_MS = 1_000;

/** Largest `ls-tree` listing read (about 500 000 paths); a larger tree fails the scan. */
export const TREE_LISTING_MAX_BYTES = 64 * 1024 * 1024;

/** `version`, `ls-remote`, `rev-parse` and `cat-file --batch-check` print a few short lines each. */
const SMALL_OUTPUT_BYTES = 1024 * 1024;

/** Proxy settings are forwarded (and redacted, as they may hold credentials); nothing else is. */
const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
];

/** What Windows needs to start processes at all (SPEC-105 §9.1). */
const WINDOWS_VARIABLES = ['SystemRoot', 'PATHEXT', 'COMSPEC'];

/**
 * The one TLS setting forwarded to git (SPEC-105 §9.1, issue #61): git's own variable for a CA
 * bundle file, read from the runner's environment only — never from any git config — and passed on
 * as its canonical path ({@link resolveCaBundle}). git hands it to libcurl as the CA file instead of
 * the default one, as it does outside DirectiveBench; some builds also keep a compiled-in CA
 * directory (Debian's and Ubuntu's read `/etc/ssl/certs` as well), so the bundle must hold every CA
 * needed (e.g. a TLS-intercepting proxy's) and may add to the system's.
 * Verification stays on: `GIT_SSL_NO_VERIFY`, `GIT_SSL_CAPATH`, `SSL_CERT_FILE`, `SSL_CERT_DIR`
 * and `NODE_EXTRA_CA_CERTS` are never forwarded.
 */
export const CA_BUNDLE_VARIABLE = 'GIT_SSL_CAINFO';

/**
 * The canonical path of the CA bundle named by {@link CA_BUNDLE_VARIABLE}, or null when it is not
 * set. Fails closed: a value that is not absolute, or does not resolve to a readable regular file
 * (a directory, a FIFO, a missing or unreadable file), refuses every hosted step rather than
 * letting git fall back to its default bundle. The message names the variable, never the path.
 */
export async function resolveCaBundle(
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; caBundle: string | null } | HostedGitFailure> {
  const value = env[CA_BUNDLE_VARIABLE];
  if (value === undefined) return { ok: true, caBundle: null };
  const refuse = (reason: string) =>
    failure(
      'git-failed',
      `${CA_BUNDLE_VARIABLE} must be the absolute path of a readable CA bundle file (${reason}). Fix or unset it to reach GitHub repositories.`,
    );
  if (!isAbsolute(value)) return refuse('not an absolute path');
  try {
    const caBundle = await realpath(value);
    if (!(await stat(caBundle)).isFile()) return refuse('not a regular file');
    await access(caBundle, constants.R_OK);
    return { ok: true, caBundle };
  } catch (error) {
    return refuse(errnoCode(error));
  }
}

/** Whether a step may download (`network`) or must fail on any missing object (`local`). */
export type GitStepKind = 'network' | 'local';

/**
 * The environment of every hosted git call (SPEC-105 §9.1): built from an allowlist, nothing
 * inherited. `HOME` is an empty directory DirectiveBench owns, and system and global config are
 * ignored, so the user's `url.*.insteadOf`, credential helpers, `http.sslVerify` and askpass
 * programs never apply; `GIT_ASKPASS`/`SSH_ASKPASS`, `GIT_SSL_NO_VERIFY` and every other `GIT_*`
 * variable are simply absent. `local` steps disable lazy fetching, so reading a missing object
 * fails instead of downloading it. Returns the proxy values to redact as well.
 *
 * git never discovers a repository: ignoring system and global config does not stop it from
 * walking up from its working directory and loading the `.git/config` of a repository enclosing
 * the data directory (lesson 2026-10-20-git-config-isolation-needs-no-discovery). A step on the cache names it as `GIT_DIR` (`gitDir`), so
 * the only repository config read is the cache's own, which DirectiveBench created; every other
 * step runs in `HOME` with `GIT_CEILING_DIRECTORIES` set to its parent, so git looks at the empty
 * `HOME` and nowhere above it.
 *
 * The only TLS setting is an explicit CA bundle (`caBundle`, from {@link resolveCaBundle}).
 */
export function buildHostedGitEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  kind: GitStepKind,
  gitDir: string | null,
  caBundle: string | null,
): { env: Record<string, string>; knownSecrets: string[] } {
  const env: Record<string, string> = {
    PATH: absolutePathEntries(base.PATH).join(delimiter),
    LANG: 'C',
    LC_ALL: 'C',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CEILING_DIRECTORIES: resolve(dirname(home)),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  if (gitDir !== null) env.GIT_DIR = resolve(gitDir);
  if (kind === 'local') env.GIT_NO_LAZY_FETCH = '1';
  // The canonical path checked by `resolveCaBundle`, never the raw value of the environment.
  if (caBundle !== null) env[CA_BUNDLE_VARIABLE] = caBundle;
  const knownSecrets: string[] = [];
  for (const name of ['TZ', ...WINDOWS_VARIABLES, ...PROXY_VARIABLES]) {
    const value = base[name];
    if (value === undefined) continue;
    env[name] = value;
    if (PROXY_VARIABLES.includes(name)) knownSecrets.push(value);
  }
  return { env, knownSecrets };
}

/**
 * The configuration prefix of every hosted git call (SPEC-105 §9.1, SPEC-201 §5.1): no hooks,
 * fsmonitor, credential helper, submodules, redirects or background maintenance, and exactly one
 * protocol. Command-line values override the repository's and the user's configuration.
 */
export function hostedGitArgs(protocol: HostedGitTransport['protocol'], args: readonly string[]) {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'protocol.allow=never',
    '-c',
    `protocol.${protocol}.allow=always`,
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
    ...args,
  ];
}

/** A hosted git step that failed; `message` is safe to show and store (no credentials, redacted). */
export interface HostedGitFailure {
  ok: false;
  code:
    | 'git-not-installed'
    | 'git-too-old'
    | 'auth-required'
    | 'unreachable'
    | 'invalid-url'
    | 'timeout'
    | 'git-failed'
    | 'branch-not-found'
    | 'cache-limit-exceeded';
  message: string;
}

function failure(code: HostedGitFailure['code'], message: string): HostedGitFailure {
  return { ok: false, code, message };
}

/**
 * The failure of a hosted step when DirectiveBench's own cache below `<dataDir>/cache` cannot be
 * created, measured, read or removed (permission denied, a full disk, …; SPEC-105 §13). The
 * message is fixed and names only the error code: a file-system error's own message names
 * absolute paths.
 */
export function cacheFailure(error: unknown): HostedGitFailure {
  return failure(
    'git-failed',
    `DirectiveBench could not use its cache of hosted repositories in the data directory (${errnoCode(error)}). Check that the data directory is writable and the disk has free space.`,
  );
}

/** The job was cancelled or the runner is shutting down; git was stopped. */
export class GitCancelledError extends Error {
  override name = 'GitCancelledError';
}

/** The message shown when a repository needs credentials (FR-104-12, D06). */
export const NOT_FOUND_OR_NOT_PUBLIC =
  'The repository was not found or is not public. DirectiveBench reads public GitHub repositories without credentials; private repositories are not supported yet.';

/**
 * git's messages (with `LC_ALL=C`) for a repository that needs authentication or does not exist.
 * GitHub answers 401 for both. With `credential.interactive=false` git reports "unable to get
 * password from user" instead of "could not read Username … terminal prompts disabled".
 */
const NOT_FOUND_PATTERNS = [
  /unable to get password from user/i,
  /could not read (?:Username|Password)/i,
  /terminal prompts disabled/i,
  /Authentication failed/i,
  /Repository not found/i,
  /The requested URL returned error: (?:401|404)/i,
  /does not appear to be a git repository/i,
];

/** git's messages for a network, DNS, TLS or proxy problem. */
const UNREACHABLE_PATTERNS = [
  /Could not resolve (?:host|proxy)/i,
  /Failed to connect/i,
  /Connection (?:refused|reset|timed out)/i,
  /Network is unreachable/i,
  /SSL|TLS|certificate/i,
  /unable to access/i,
];

/** The first line of git's error output without its `fatal: ` prefix. */
function firstLine(stderr: string): string {
  const line =
    stderr
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text !== '' && !text.startsWith('warning:')) ?? '';
  return line.replace(/^(?:fatal|error): /, '') || 'no message';
}

/** Maps a failed remote step (`ls-remote`, clone, fetch) to a typed failure (SPEC-104 §13). */
export function classifyRemoteFailure(stderr: string, host: string): HostedGitFailure {
  if (/The requested URL returned error: 30\d/.test(stderr)) {
    return failure(
      'invalid-url',
      'The repository URL redirects elsewhere (it was probably renamed or moved). Register its new URL.',
    );
  }
  // GitHub also answers 403 for rate and abuse limits: not evidence that the repository is private.
  if (/The requested URL returned error: 403/.test(stderr)) {
    return failure(
      'unreachable',
      `${host} refused the request (HTTP 403, for example a rate limit). Try again later.`,
    );
  }
  if (NOT_FOUND_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return failure('auth-required', NOT_FOUND_OR_NOT_PUBLIC);
  }
  if (UNREACHABLE_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return failure(
      'unreachable',
      `Could not reach ${host}: ${firstLine(stderr)}. Check the network connection or proxy.`,
    );
  }
  return failure('git-failed', `git failed: ${firstLine(stderr)}`);
}

/** Everything a hosted git step needs besides its own arguments. */
export interface HostedGitContext {
  /** Absolute path of git, located on the absolute `PATH` entries. */
  git: string;
  /** The runner's environment; only allowlisted variables are taken from it. */
  env: NodeJS.ProcessEnv;
  /** Empty directory used as git's `HOME`. */
  home: string;
  /** Canonical path of the CA bundle git uses instead of its default, or null (`resolveCaBundle`). */
  caBundle: string | null;
  transport: HostedGitTransport;
  signal: AbortSignal;
  timeouts: HostedGitTimeouts;
  /** Largest cache of one repository in bytes. */
  cacheLimitBytes: number;
  cacheSizePollIntervalMs: number;
}

interface StepOptions {
  /** The cache repository the step works on (`GIT_DIR` and working directory); null: none, in `HOME`. */
  gitDir: string | null;
  kind: GitStepKind;
  timeoutMs: number;
  maxStdoutBytes: number;
  stdin?: Buffer;
  /** A cache directory measured while git runs; git is killed when it exceeds the limit. */
  watchSize?: string;
}

async function runStep(
  context: HostedGitContext,
  args: readonly string[],
  options: StepOptions,
): Promise<GitProcessResult> {
  const { env, knownSecrets } = buildHostedGitEnv(
    context.env,
    context.home,
    options.kind,
    options.gitDir,
    context.caBundle,
  );
  const { watchSize } = options;
  const sizeCheck: { failure?: { error: unknown } } = {};
  const result = await runGitProcess(context.git, hostedGitArgs(context.transport.protocol, args), {
    cwd: options.gitDir ?? context.home,
    env,
    ...(options.stdin ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    signal: context.signal,
    killGraceMs: HOSTED_GIT_KILL_GRACE_MS,
    knownSecrets,
    ...(watchSize
      ? {
          watch: {
            intervalMs: context.cacheSizePollIntervalMs,
            exceeded: async () => {
              try {
                return (await directorySize(watchSize)) > context.cacheLimitBytes;
              } catch (error) {
                sizeCheck.failure = { error };
                throw error;
              }
            },
          },
        }
      : {}),
  });
  if (result.cancelled) throw new GitCancelledError('git was stopped: the job was cancelled');
  // A size check that failed (and stopped git) is thrown like every other error of the cache;
  // the scan or registration reports it (fail closed: the size was not measured). One that fails
  // only after git exited may land too late to be seen here; the measurement every download
  // makes afterwards (`directorySize`) then fails the same way.
  if (sizeCheck.failure) throw sizeCheck.failure.error;
  // Messages built from git's errors never name the absolute cache location or the CA bundle's
  // path (git names it when it cannot use the file; FR-105-15).
  const hide = (text: string) => {
    const hidden = text.split(dirname(context.home)).join('<cache>');
    return context.caBundle === null ? hidden : hidden.split(context.caBundle).join('<CA bundle>');
  };
  return {
    ...result,
    stderr: hide(result.stderr),
    error: result.error === null ? null : hide(result.error),
  };
}

/** The typed failure for a git run that did not finish normally, or null when it exited. */
function abnormal(result: GitProcessResult, step: string, context: HostedGitContext) {
  // git could not be started or fed. (A size check that failed was thrown by `runStep`.)
  if (result.error !== null) return failure('git-failed', `${step} failed: ${result.error}`);
  if (result.watchTriggered) return cacheLimitFailure(context);
  if (result.timedOut) return failure('timeout', `${step} did not finish within the time limit.`);
  if (result.outputExceeded) {
    return failure('git-failed', `${step} printed more output than DirectiveBench reads.`);
  }
  return null;
}

function cacheLimitFailure(context: HostedGitContext): HostedGitFailure {
  return failure(
    'cache-limit-exceeded',
    `The download exceeded the cache limit of ${Math.round(context.cacheLimitBytes / 1024 / 1024)} MiB for one repository, so it was stopped and the cache deleted.`,
  );
}

/** Total size of the regular files below `path` (symlinks are not followed); 0 when absent. */
export async function directorySize(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(absentAs(null));
  if (entries === null) return 0;
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    // git renames and removes temporary pack files while it runs: a file gone since the listing
    // takes no space any more. Any other error cannot vouch for the size (fail closed).
    else total += (await lstat(child).catch(absentAs({ size: 0 }))).size;
  }
  return total;
}

/** A rejection handler that turns `ENOENT` into `value` and rethrows every other error. */
function absentAs<T>(value: T): (error: unknown) => T {
  return (error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return value;
    throw error;
  };
}

/** Creates (or tightens) a directory only the current user can enter (SPEC-105 §12, 0700). */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/**
 * Checks that git supports `GIT_NO_LAZY_FETCH` (≥ 2.44, NFR-104-03). Older git would ignore it
 * and download on any read of a missing object, so hosted repositories are refused (fail closed).
 */
export async function checkGitVersion(context: HostedGitContext): Promise<HostedGitFailure | null> {
  const result = await runStep(context, ['version'], {
    gitDir: null,
    kind: 'local',
    timeoutMs: context.timeouts.version,
    maxStdoutBytes: SMALL_OUTPUT_BYTES,
  });
  const problem = abnormal(result, 'git version', context);
  if (problem) return problem;
  const match = /^git version (\d+)\.(\d+)/.exec(result.stdout.toString('utf8'));
  const { major, minor } = MIN_HOSTED_GIT_VERSION;
  if (
    match &&
    (Number(match[1]) > major || (Number(match[1]) === major && Number(match[2]) >= minor))
  ) {
    return null;
  }
  return failure(
    'git-too-old',
    `GitHub repositories need git ${major}.${minor} or newer (it can disable implicit downloads); this git reports "${result.stdout.toString('utf8').trim().slice(0, 80)}".`,
  );
}

/**
 * A branch name DirectiveBench passes to git: letters, digits, `.`, `_`, `-` and `/` segments,
 * none empty or starting with `.`, no `..`, not starting with `-` (never an option) and not ending
 * in `.lock` — a subset of what `git check-ref-format` accepts.
 */
export function isSafeBranchName(name: string): boolean {
  return (
    name.length <= 255 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith('-') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    name.split('/').every((segment) => segment !== '' && !segment.startsWith('.'))
  );
}

/** Decodes git's output as UTF-8, or null when it is not valid UTF-8. */
function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Asks the remote for its default branch (FR-104-07: `ls-remote --symref <url> HEAD`) without
 * downloading anything. A repository that needs credentials fails with "not found or not public",
 * and no prompt can appear (FR-104-12). An empty repository has no default branch (null); so does
 * a branch name outside {@link isSafeBranchName}.
 */
export async function detectDefaultBranch(
  context: HostedGitContext,
  location: string,
): Promise<{ ok: true; defaultBranch: string | null } | HostedGitFailure> {
  const result = await runStep(
    context,
    ['ls-remote', '--symref', '--', context.transport.remoteUrl(location), 'HEAD'],
    {
      gitDir: null,
      kind: 'network',
      timeoutMs: context.timeouts.lsRemote,
      maxStdoutBytes: SMALL_OUTPUT_BYTES,
    },
  );
  const problem = abnormal(result, 'git ls-remote', context);
  if (problem) return problem;
  if (result.exitCode !== 0) return classifyRemoteFailure(result.stderr, new URL(location).host);
  // Lossy decoding is harmless here: a name with a replacement character is not a safe name.
  const lines = result.stdout.toString('utf8').split('\n');
  const symref = lines
    .map((line) => /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line)?.[1])
    .find((name) => name !== undefined);
  return {
    ok: true,
    defaultBranch: symref !== undefined && isSafeBranchName(symref) ? symref : null,
  };
}

/** A full object ID: SHA-1 (40) or SHA-256 (64) hex. */
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Step 1 of SPEC-105 §9.1: the commit and its trees only, into the bare cache — a blob-less,
 * shallow, single-branch clone without tags, templates (so no sample hooks), working tree or
 * checkout; an existing cache is fetched into instead. The snapshot commit is then read from the
 * cache. The cache size is watched during the download. On failure the cache is deleted, so the
 * next scan starts from a fresh clone; a failing fetch into an existing cache is retried once as
 * a fresh clone.
 */
export async function fetchSnapshot(
  context: HostedGitContext,
  target: { location: string; branch: string; cacheDir: string },
): Promise<{ ok: true; commitSha: string } | HostedGitFailure> {
  // Absent: clone. Any other error is a cache that cannot be checked (fail closed).
  const exists = await lstat(target.cacheDir).then(() => true, absentAs(false));
  if (exists) {
    const fetched = await fetchInto(context, target);
    if (fetched.ok) return fetched;
    await rm(target.cacheDir, { recursive: true, force: true });
  }
  const cloned = await cloneInto(context, target);
  if (!cloned.ok) await rm(target.cacheDir, { recursive: true, force: true });
  return cloned;
}

async function cloneInto(
  context: HostedGitContext,
  target: { location: string; branch: string; cacheDir: string },
): Promise<{ ok: true; commitSha: string } | HostedGitFailure> {
  const result = await runStep(
    context,
    [
      'clone',
      '--bare',
      '--filter=blob:none',
      '--depth',
      '1',
      '--single-branch',
      '--no-tags',
      '--template=',
      '--branch',
      target.branch,
      '--',
      context.transport.remoteUrl(target.location),
      // Absolute: the clone runs in HOME.
      resolve(target.cacheDir),
    ],
    {
      gitDir: null,
      kind: 'network',
      timeoutMs: context.timeouts.fetch,
      maxStdoutBytes: SMALL_OUTPUT_BYTES,
      watchSize: target.cacheDir,
    },
  );
  return finishDownload(context, result, 'git clone', target);
}

async function fetchInto(
  context: HostedGitContext,
  target: { location: string; branch: string; cacheDir: string },
): Promise<{ ok: true; commitSha: string } | HostedGitFailure> {
  const ref = `refs/heads/${target.branch}`;
  const result = await runStep(
    context,
    [
      'fetch',
      '--depth',
      '1',
      '--filter=blob:none',
      '--no-tags',
      '--no-write-fetch-head',
      '--recurse-submodules=no',
      'origin',
      `+${ref}:${ref}`,
    ],
    {
      gitDir: target.cacheDir,
      kind: 'network',
      timeoutMs: context.timeouts.fetch,
      maxStdoutBytes: SMALL_OUTPUT_BYTES,
      watchSize: target.cacheDir,
    },
  );
  return finishDownload(context, result, 'git fetch', target);
}

async function finishDownload(
  context: HostedGitContext,
  result: GitProcessResult,
  step: string,
  target: { location: string; branch: string; cacheDir: string },
): Promise<{ ok: true; commitSha: string } | HostedGitFailure> {
  const problem = abnormal(result, step, context);
  if (problem) return problem;
  if (result.exitCode !== 0) {
    if (/Remote branch .* not found|couldn't find remote ref/i.test(result.stderr)) {
      return failure(
        'branch-not-found',
        `The branch ${target.branch} does not exist in the repository. If its default branch was renamed, register its URL again to detect the new one.`,
      );
    }
    return classifyRemoteFailure(result.stderr, new URL(target.location).host);
  }
  if ((await directorySize(target.cacheDir)) > context.cacheLimitBytes) {
    return cacheLimitFailure(context);
  }
  await chmod(target.cacheDir, 0o700);
  const head = await runStep(
    context,
    ['rev-parse', '--verify', `refs/heads/${target.branch}^{commit}`],
    {
      gitDir: target.cacheDir,
      kind: 'local',
      timeoutMs: context.timeouts.read,
      maxStdoutBytes: SMALL_OUTPUT_BYTES,
    },
  );
  const commitSha = head.stdout.toString('utf8').trim();
  if (
    abnormal(head, 'git rev-parse', context) ||
    head.exitCode !== 0 ||
    !OBJECT_ID.test(commitSha)
  ) {
    return failure('git-failed', 'The fetched commit could not be read from the cache.');
  }
  return { ok: true, commitSha };
}

/** A file or symlink of the snapshot with its blob ID. */
export interface SnapshotEntry extends RepositoryTreeEntry {
  oid: string;
}

/**
 * Step 2: lists the whole commit (`ls-tree -r -z --full-tree`, without `--long`, which would fetch
 * blobs to report sizes). Regular files (`100644`, `100755`) and symlinks (`120000`) are kept;
 * submodules (`160000`) are skipped (FR-105-06). git canonicalises every mode when it reads a tree
 * (a legacy `100664` or `100000` lists as `100644`, an unknown one as a `160000` submodule), so a
 * real repository lists no other mode: one that does is output DirectiveBench does not understand
 * and fails closed (SPEC-105 §20, issue #61). Paths are raw bytes and must be valid UTF-8.
 */
export async function listSnapshot(
  context: HostedGitContext,
  cacheDir: string,
  commitSha: string,
): Promise<{ ok: true; entries: SnapshotEntry[] } | HostedGitFailure> {
  const result = await runStep(context, ['ls-tree', '-r', '-z', '--full-tree', commitSha], {
    gitDir: cacheDir,
    kind: 'local',
    timeoutMs: context.timeouts.read,
    maxStdoutBytes: TREE_LISTING_MAX_BYTES,
  });
  const problem = abnormal(result, 'git ls-tree', context);
  if (problem) return problem;
  if (result.exitCode !== 0) {
    return failure('git-failed', `git ls-tree failed: ${firstLine(result.stderr)}`);
  }
  const entries: SnapshotEntry[] = [];
  const records = result.stdout.toString('latin1').split('\0');
  records.pop(); // the listing ends with a NUL
  for (const record of records) {
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([\s\S]+)$/.exec(record);
    // latin1 maps bytes to code units one to one, so the path's bytes are recovered exactly.
    const path = match ? utf8(Buffer.from(String(match[4]), 'latin1')) : null;
    if (!match || path === null) {
      return failure(
        'git-failed',
        'The repository tree has an entry DirectiveBench does not accept (for example a file name that is not valid UTF-8).',
      );
    }
    const [, mode, type, oid] = match as unknown as [string, string, string, string];
    if (type === 'commit' && mode === '160000') continue;
    if (type === 'blob' && (mode === '100644' || mode === '100755')) {
      entries.push({ path, kind: 'file', oid });
    } else if (type === 'blob' && mode === '120000') {
      entries.push({ path, kind: 'symlink', oid });
    } else {
      return failure('git-failed', `The repository tree has an entry of unsupported mode ${mode}.`);
    }
  }
  return { ok: true, entries };
}

/** `cat-file --batch-check` with lazy fetching disabled: the size of each present blob. */
async function presentBlobs(
  context: HostedGitContext,
  cacheDir: string,
  oids: readonly string[],
): Promise<{ ok: true; sizes: Map<string, number> } | HostedGitFailure> {
  const sizes = new Map<string, number>();
  if (oids.length === 0) return { ok: true, sizes };
  const result = await runStep(context, ['cat-file', '--batch-check'], {
    gitDir: cacheDir,
    kind: 'local',
    timeoutMs: context.timeouts.read,
    maxStdoutBytes: oids.length * 128,
    stdin: Buffer.from(`${oids.join('\n')}\n`),
  });
  const problem = abnormal(result, 'git cat-file', context);
  if (problem) return problem;
  if (result.exitCode !== 0) {
    return failure('git-failed', `git cat-file failed: ${firstLine(result.stderr)}`);
  }
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line);
    if (match) sizes.set(String(match[1]), Number(match[2]));
  }
  return { ok: true, sizes };
}

/**
 * Steps 4 and 5 pre-check: makes every candidate blob present in the cache with one batched
 * fetch by object ID (`fetch.negotiationAlgorithm=noop`, lessons 2026-10-17) of only those not
 * already there, then returns all their sizes. A blob still missing afterwards fails the scan; it
 * is never fetched implicitly.
 */
export async function fetchBlobs(
  context: HostedGitContext,
  target: { cacheDir: string; location: string },
  oids: readonly string[],
): Promise<{ ok: true; sizes: Map<string, number> } | HostedGitFailure> {
  const before = await presentBlobs(context, target.cacheDir, oids);
  if (!before.ok) return before;
  const missing = oids.filter((oid) => !before.sizes.has(oid));
  if (missing.length === 0) return before;
  const result = await runStep(
    context,
    [
      '-c',
      'fetch.negotiationAlgorithm=noop',
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--recurse-submodules=no',
      '--filter=blob:none',
      '--stdin',
      'origin',
    ],
    {
      gitDir: target.cacheDir,
      kind: 'network',
      timeoutMs: context.timeouts.fetch,
      maxStdoutBytes: SMALL_OUTPUT_BYTES,
      stdin: Buffer.from(`${missing.join('\n')}\n`),
      watchSize: target.cacheDir,
    },
  );
  const problem = abnormal(result, 'git fetch', context);
  if (problem) return problem;
  if (result.exitCode !== 0)
    return classifyRemoteFailure(result.stderr, new URL(target.location).host);
  if ((await directorySize(target.cacheDir)) > context.cacheLimitBytes) {
    return cacheLimitFailure(context);
  }
  const after = await presentBlobs(context, target.cacheDir, oids);
  if (!after.ok) return after;
  if (after.sizes.size !== new Set(oids).size) {
    return failure('git-failed', 'The repository did not send every requested file.');
  }
  return after;
}

/**
 * Step 5: reads the blobs from the cache with `cat-file --batch` and lazy fetching disabled —
 * never `--filters` or `--textconv` — as the exact bytes committed, within `timeoutMs` (at most
 * `timeouts.read`, less when the scan's `timeouts.readTotal` is nearly spent). The caller passes
 * only blobs within its size limits; the output is bounded by their total.
 */
export async function readBlobs(
  context: HostedGitContext,
  cacheDir: string,
  blobs: ReadonlyMap<string, number>,
  timeoutMs: number,
): Promise<{ ok: true; contents: Map<string, Buffer> } | HostedGitFailure> {
  const contents = new Map<string, Buffer>();
  if (blobs.size === 0) return { ok: true, contents };
  const oids = [...blobs.keys()];
  const total = [...blobs.values()].reduce((sum, size) => sum + size, 0);
  // Each object is `<oid> blob <size>\n<content>\n`.
  const result = await runStep(context, ['cat-file', '--batch'], {
    gitDir: cacheDir,
    kind: 'local',
    timeoutMs,
    maxStdoutBytes: total + oids.length * 128,
    stdin: Buffer.from(`${oids.join('\n')}\n`),
  });
  const problem = abnormal(result, 'git cat-file', context);
  if (problem) return problem;
  if (result.exitCode !== 0) {
    return failure('git-failed', `git cat-file failed: ${firstLine(result.stderr)}`);
  }
  let offset = 0;
  const output = result.stdout;
  for (const [oid, size] of blobs) {
    const end = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, Math.max(end, offset)).toString('utf8');
    if (header !== `${oid} blob ${size}` || end + 1 + size > output.length) {
      return failure('git-failed', 'A file could not be read from the cache.');
    }
    contents.set(oid, output.subarray(end + 1, end + 1 + size));
    offset = end + 1 + size + 1;
  }
  return { ok: true, contents };
}
