import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { runCommand, type CommandResult } from '@directivebench/benchmark-engine';
import { expandHomePath } from '@directivebench/core';
import {
  registerLocalRepository,
  type Database,
  type RepositoryRegistrationErrorCode,
  type RepositoryRegistrationResult,
} from '@directivebench/database';

/** NFR-104-01: local validation completes or times out within 2 s (applied per git call). */
export const LOCAL_GIT_TIMEOUT_MS = 2_000;

/** The queries below print one short line each; a longer answer is cut off and rejected. */
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Variables forwarded to git. `HOME`/`XDG_CONFIG_HOME` let git read the user's global config
 * (e.g. `safe.directory`); nothing else is inherited, in particular no `GIT_DIR`,
 * `GIT_CONFIG_PARAMETERS` or other `GIT_*` variable that could redirect or reconfigure git.
 */
const GIT_ENV_ALLOWLIST = ['PATH', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'SystemRoot'];

/**
 * Configuration that keeps git from running repository-controlled code (SPEC-104 FR-104-12).
 * Command-line `-c` values override the repository's own `.git/config` and the user's config.
 * Git for Windows maps `/dev/null` to `NUL`, so the same value disables hooks there.
 */
const HARDENED_GIT_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.ext.allow=never',
] as const;

/** The only git commands registration runs: read-only plumbing, no user input in argv. */
const WORK_TREE_QUERY = ['rev-parse', '--is-inside-work-tree', '--show-cdup'] as const;
const BRANCH_QUERY = ['symbolic-ref', '--quiet', '--short', 'HEAD'] as const;

/** `--show-cdup` prints only `../` segments, so the top level can never leave the start path. */
const CDUP_PATTERN = /^(?:\.\.\/)*$/;

/** Prefixes git's arguments with the hardening configuration. */
export function hardenedGitArgs(args: readonly string[]): string[] {
  return [...HARDENED_GIT_CONFIG, ...args];
}

/**
 * The complete environment for git: the allowlisted variables plus settings that disable
 * prompts, optional index writes (`GIT_OPTIONAL_LOCKS=0`), LFS smudging and lazy fetches, and
 * pin the message language so git's errors can be recognised.
 */
export function buildGitEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of GIT_ENV_ALLOWLIST) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_NO_LAZY_FETCH: '1',
  };
}

/** The registration was aborted (user cancellation or runner shutdown). */
export class RegistrationCancelledError extends Error {
  override name = 'RegistrationCancelledError';
}

export interface LocalPathInspectionOptions {
  /** Expansion target for `~`. */
  homeDir: string;
  /** Environment git's allowlisted variables are taken from. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs?: number;
}

export type LocalPathInspection =
  | {
      ok: true;
      provider: 'local-git' | 'local-directory';
      /** Canonical absolute path: the work tree's top level for `local-git`. */
      location: string;
      name: string;
      defaultBranch: string | null;
    }
  | { ok: false; code: RepositoryRegistrationErrorCode; message: string };

type Rejection = Extract<LocalPathInspection, { ok: false }>;

function reject(code: RepositoryRegistrationErrorCode, message: string): Rejection {
  return { ok: false, code, message };
}

/** File-system errors that mean "there is no directory to register here". */
const MISSING_PATH_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP']);
const DENIED_PATH_ERRORS = new Set(['EACCES', 'EPERM']);

/**
 * Canonicalises the path (`~`, trailing slashes and symlinks via `realpath`) and checks that it
 * is a readable directory. Nothing is created or modified. Unexpected errors are rethrown so the
 * job fails instead of registering a path that was not checked (fail closed).
 */
async function resolveDirectory(path: string, homeDir: string): Promise<string | Rejection> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(expandHomePath(path, homeDir)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (MISSING_PATH_ERRORS.has(code)) {
      return reject('path-not-found', 'No directory exists at this path.');
    }
    if (DENIED_PATH_ERRORS.has(code)) {
      return reject('permission-denied', 'DirectiveBench cannot access this path.');
    }
    throw error;
  }
  if (!(await stat(canonical)).isDirectory()) {
    return reject('not-a-directory', 'This path is a file, not a directory.');
  }
  try {
    // Listing (R) and entering (X) the directory is what a scan needs.
    await access(canonical, constants.R_OK | constants.X_OK);
  } catch {
    return reject('permission-denied', 'DirectiveBench cannot read this directory.');
  }
  return canonical;
}

function runGit(
  query: readonly string[],
  cwd: string,
  options: LocalPathInspectionOptions,
  timeoutMs: number,
): Promise<CommandResult> {
  // The path is the working directory, never an argument, so it cannot inject git options.
  return runCommand(['git', ...hardenedGitArgs(query)], {
    cwd,
    env: buildGitEnv(options.env),
    timeoutMs,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    signal: options.signal,
  });
}

/** Turns a git run that did not exit on its own into a rejection, or throws on cancellation. */
function abnormalExit(result: CommandResult, timeoutMs: number): Rejection | null {
  if (result.cancelled) throw new RegistrationCancelledError('Registration was cancelled');
  if (result.error !== null) {
    return reject('git-not-installed', 'git was not found on PATH or could not be started.');
  }
  if (result.timedOut) {
    return reject('timeout', `git did not answer within ${timeoutMs / 1000} s.`);
  }
  return null;
}

function lines(output: string): string[] {
  return output.split('\n');
}

/** Repository name default: the directory's basename (FR-104-06); `/` has none. */
function nameOf(location: string): string {
  return basename(location) || location;
}

/**
 * Decides what a local path is without modifying it (SPEC-104 FR-104-03, FR-104-07, FR-104-11,
 * FR-104-12): a git work tree (`local-git`, located at its top level, with the current branch)
 * or a plain directory (`local-directory`). Anything else is a typed rejection.
 */
export async function inspectLocalPath(
  path: string,
  options: LocalPathInspectionOptions,
): Promise<LocalPathInspection> {
  const directory = await resolveDirectory(path, options.homeDir);
  if (typeof directory !== 'string') return directory;

  const timeoutMs = options.timeoutMs ?? LOCAL_GIT_TIMEOUT_MS;
  const workTree = await runGit(WORK_TREE_QUERY, directory, options, timeoutMs);
  const failure = abnormalExit(workTree, timeoutMs);
  if (failure) return failure;

  if (workTree.exitCode !== 0) {
    if (workTree.stderr.includes('not a git repository')) {
      return {
        ok: true,
        provider: 'local-directory',
        location: directory,
        name: nameOf(directory),
        defaultBranch: null,
      };
    }
    const reason =
      workTree.stderr
        .split('\n', 1)
        .join('')
        .replace(/^fatal: /, '') || 'no message';
    return reject('git-failed', `git could not inspect this path: ${reason}`);
  }

  const [inside, cdup = ''] = lines(workTree.stdout);
  if (inside === 'false') {
    return reject(
      'git-directory',
      'This path is inside a Git directory (.git) or a bare repository, not a work tree.',
    );
  }
  if (inside !== 'true' || !CDUP_PATTERN.test(cdup)) {
    return reject('git-failed', 'git returned an unexpected answer for this path.');
  }
  const topLevel = resolve(directory, cdup);

  const branch = await runGit(BRANCH_QUERY, topLevel, options, timeoutMs);
  if (branch.cancelled) throw new RegistrationCancelledError('Registration was cancelled');
  // Exit code 1 means a detached HEAD. The branch is informative only, so any other failure
  // also leaves it unknown rather than blocking the registration.
  const defaultBranch =
    branch.exitCode === 0 ? branch.stdout.split('\n', 1).join('') || null : null;
  return {
    ok: true,
    provider: 'local-git',
    location: topLevel,
    name: nameOf(topLevel),
    defaultBranch,
  };
}

/**
 * Executes a `repository-registration` job: inspects the path and stores the repository, or
 * returns the existing one for the same canonical location (FR-104-04). A rejected path stores
 * nothing.
 */
export async function registerLocalPath(
  db: Database,
  path: string,
  options: LocalPathInspectionOptions,
): Promise<RepositoryRegistrationResult> {
  const inspection = await inspectLocalPath(path, options);
  if (!inspection.ok) return inspection;
  const { repository, created } = await registerLocalRepository(db, {
    provider: inspection.provider,
    name: inspection.name,
    location: inspection.location,
    defaultBranch: inspection.defaultBranch,
  });
  return { ok: true, repositoryId: repository.id, created };
}
