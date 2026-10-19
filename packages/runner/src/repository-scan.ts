import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DiscoveryRootChangedError,
  discoverArtifacts,
  isFilesystemRoot,
  redactSecrets,
  type DiscoveredArtifact,
} from '@directivebench/core';
import {
  JobNoLongerRunningError,
  MAX_REPORTED_SCAN_ERRORS,
  MAX_SKIPPED_USER_LEVEL_FOLDERS,
  NotFoundError,
  SCANNABLE_PROVIDERS,
  applyRepositoryScan,
  getRepository,
  markRepositoryScanFailed,
  type DatabaseHandle,
  type RepositoryScanErrorCode,
  type RepositoryScanResult,
  type ScannedArtifactInput,
} from '@directivebench/database';

/** The scan was aborted (user cancellation or runner shutdown); nothing was written. */
export class ScanCancelledError extends Error {
  override name = 'ScanCancelledError';
}

export interface RepositoryScanOptions {
  signal: AbortSignal;
  /** The user's home directory, whose agent folders are never scanned (D05). */
  homeDir: string;
  /** Read for `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. */
  env: NodeJS.ProcessEnv;
}

/**
 * The agents' user-level folders below the home directory, as named by the integration specs:
 * Claude Code (`~/.claude`, `CLAUDE_CONFIG_DIR` — SPEC-203), Codex (`~/.codex`, `CODEX_HOME`, and
 * `~/.agents` for user-level skills — SPEC-204), Cursor (`~/.cursor`, `$XDG_CONFIG_HOME/cursor` —
 * SPEC-205). Product decision D05 keeps them out of every scan: they are an opt-in that does not
 * exist yet, so a scan of the home directory (or of an ancestor) skips them.
 */
const USER_LEVEL_FOLDER_NAMES = ['.agents', '.claude', '.codex', '.cursor'];

/**
 * The canonical paths a scan never enters (D05): each user-level folder as it is spelled below the
 * canonical home directory and, when it is a symlink (dotfiles), where it resolves to. Relative
 * environment values are ignored, as the agents ignore them.
 */
export async function userLevelAgentFolders(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const home = await realpath(homeDir).catch(() => resolve(homeDir));
  const absolute = (value: string | undefined) =>
    value !== undefined && isAbsolute(value) ? [resolve(value)] : [];
  const configHome = absolute(env.XDG_CONFIG_HOME)[0] ?? join(home, '.config');
  const folders = [
    ...USER_LEVEL_FOLDER_NAMES.map((name) => join(home, name)),
    join(configHome, 'cursor'),
    ...absolute(env.CLAUDE_CONFIG_DIR),
    ...absolute(env.CODEX_HOME),
  ];
  const resolved = await Promise.all(folders.map((folder) => realpath(folder).catch(() => null)));
  const all = [...folders, ...resolved.filter((folder): folder is string => folder !== null)];
  return [...new Set(all)].sort();
}

type ScanFailure = Extract<RepositoryScanResult, { ok: false }>;

function failure(code: RepositoryScanErrorCode, message: string): ScanFailure {
  return { ok: false, code, message };
}

/** File-system errors that mean "the registered directory is gone". */
const MISSING_PATH_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP']);
const DENIED_PATH_ERRORS = new Set(['EACCES', 'EPERM']);

/** The error's `code` (`EIO`, …), or null. Messages never carry the error text: it holds paths. */
function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** A failure to resolve or `stat` the location: classified by its code, never rethrown. */
function locationFailure(error: unknown): ScanFailure {
  const code = errorCode(error);
  if (code !== null && MISSING_PATH_ERRORS.has(code)) {
    return failure('path-not-found', 'The registered directory no longer exists.');
  }
  if (code !== null && DENIED_PATH_ERRORS.has(code)) {
    return failure('permission-denied', 'DirectiveBench cannot access the registered directory.');
  }
  return failure(
    'scan-failed',
    `The scan failed: the registered directory could not be checked (${code ?? 'unknown error'}).`,
  );
}

/**
 * Checks that the registered location still is the readable directory that was registered:
 * `realpath` must return the stored canonical path unchanged, so a location that was replaced by
 * a symlink, or moved, is refused instead of scanning wherever it now points. Any other error
 * fails the scan (fail closed).
 */
async function checkLocation(location: string): Promise<ScanFailure | null> {
  let canonical: string;
  let isDirectory: boolean;
  try {
    canonical = await realpath(location);
    if (canonical !== location) return locationChanged();
    isDirectory = (await stat(canonical)).isDirectory();
  } catch (error) {
    return locationFailure(error);
  }
  if (!isDirectory) {
    return failure('not-a-directory', 'The registered location is no longer a directory.');
  }
  try {
    await access(canonical, constants.R_OK | constants.X_OK);
  } catch {
    return failure('permission-denied', 'DirectiveBench cannot read the registered directory.');
  }
  return null;
}

function locationChanged(): ScanFailure {
  return failure(
    'location-changed',
    'The registered location now resolves to another place (it was moved or replaced by a symbolic link). Register the directory again.',
  );
}

/** The stored form of a discovered artifact: what `importArtifactVersion`'s writer receives. */
function toScannedArtifact(artifact: DiscoveredArtifact): ScannedArtifactInput {
  return {
    path: artifact.occurrencePath,
    name: artifact.parsed.name,
    type: artifact.parsed.type,
    description: artifact.parsed.description,
    format: artifact.parsed.format,
    primaryFile: artifact.primaryFile,
    files: artifact.files,
    parsedMetadata: {
      frontmatter: artifact.parsed.frontmatter,
      activation: artifact.parsed.activation,
      references: artifact.parsed.references,
      warnings: artifact.warnings,
      skipped: artifact.skipped,
    },
  };
}

/**
 * The message of an unexpected discovery failure, without the repository's absolute location: the
 * error code when there is one, else the message with the location replaced, redacted.
 */
function discoveryFailure(error: unknown, location: string): ScanFailure {
  const code = errorCode(error);
  if (code !== null) {
    return failure('scan-failed', `The scan failed: the directory could not be read (${code}).`);
  }
  const message = (error instanceof Error ? error.message : String(error))
    .split(location)
    .join('<repository>');
  return failure('scan-failed', redactSecrets(`The scan failed: ${message}`));
}

/**
 * Executes a `repository-scan` job (SPEC-102, SPEC-105 FR-105-02…07, FR-105-17): walks the
 * registered local directory with `discoverArtifacts` and stores what it finds.
 *
 * The scan reads the working tree as it is on disk — for `local-git` too — and runs no process
 * at all, so no git hook, filter, fsmonitor or package script can run; discovered files are read
 * as bytes and parsed as text, never executed. `.git/`, `node_modules/` and the user-level agent
 * folders (D05) are skipped and symlinks are never followed. The location must still resolve to
 * itself, and each directory is re-checked before it is read, so a tree changed during the scan
 * cannot redirect it; a swap between that check and the read is not detected (SPEC-102 §14).
 * Every failure — expected or not — records `sync_status = 'error'` and returns a typed failure
 * whose message holds no absolute path; per-artifact discovery errors are part of a success.
 */
export async function scanLocalRepository(
  handle: DatabaseHandle,
  job: { jobId: string; repositoryId: string },
  options: RepositoryScanOptions,
): Promise<RepositoryScanResult> {
  const started = performance.now();
  const { db } = handle;
  const repository = await getRepository(db, job.repositoryId);
  if (!repository) return failure('repository-not-found', 'The repository no longer exists.');
  if (!(SCANNABLE_PROVIDERS as readonly string[]).includes(repository.provider)) {
    return failure('unsupported-provider', 'Only local repositories can be scanned so far.');
  }

  const fail = async (result: ScanFailure): Promise<ScanFailure> => {
    await markRepositoryScanFailed(db, repository.id, result.message);
    return result;
  };
  if (isFilesystemRoot(repository.location)) {
    return fail(failure('filesystem-root', 'The filesystem root cannot be scanned.'));
  }
  const problem = await checkLocation(repository.location);
  if (problem) return fail(problem);

  let discovery;
  try {
    discovery = await discoverArtifacts(repository.location, {
      signal: options.signal,
      expectedRoot: repository.location,
      skipDirectories: await userLevelAgentFolders(options.homeDir, options.env),
    });
  } catch (error) {
    if (options.signal.aborted) throw new ScanCancelledError('Scan was cancelled');
    if (error instanceof DiscoveryRootChangedError) return fail(locationChanged());
    return fail(discoveryFailure(error, repository.location));
  }
  // Cancellation is honoured until the apply transaction starts (FR-105-17).
  if (options.signal.aborted) throw new ScanCancelledError('Scan was cancelled');

  let summary;
  try {
    summary = await applyRepositoryScan(handle, {
      repositoryId: repository.id,
      jobId: job.jobId,
      artifacts: discovery.artifacts.map(toScannedArtifact),
    });
  } catch (error) {
    if (error instanceof JobNoLongerRunningError) {
      throw new ScanCancelledError('Scan was cancelled');
    }
    if (error instanceof NotFoundError) {
      return failure('repository-not-found', 'The repository was removed during the scan.');
    }
    // Not the message: a failed query's message carries its parameters, i.e. file contents.
    const cause = (error as { cause?: unknown } | null)?.cause;
    const code = errorCode(error) ?? errorCode(cause) ?? 'unknown error';
    return fail(
      failure('scan-failed', `The scan failed: the results could not be stored (${code}).`),
    );
  }
  return {
    ok: true,
    scannedFiles: discovery.scannedFiles,
    discovered: discovery.artifacts.length,
    createdArtifacts: summary.createdArtifacts,
    createdVersions: summary.createdVersions,
    warningCount: discovery.artifacts.reduce((sum, a) => sum + a.warnings.length, 0),
    errorCount: discovery.errors.length,
    errors: discovery.errors.slice(0, MAX_REPORTED_SCAN_ERRORS),
    skippedUserLevelFolders: discovery.skippedDirectories.slice(0, MAX_SKIPPED_USER_LEVEL_FOLDERS),
    durationMs: Math.round(performance.now() - started),
  };
}
