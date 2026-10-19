import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
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
}

type ScanFailure = Extract<RepositoryScanResult, { ok: false }>;

function failure(code: RepositoryScanErrorCode, message: string): ScanFailure {
  return { ok: false, code, message };
}

/** File-system errors that mean "the registered directory is gone". */
const MISSING_PATH_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP']);
const DENIED_PATH_ERRORS = new Set(['EACCES', 'EPERM']);

/**
 * Checks that the registered location still is the readable directory that was registered:
 * `realpath` must return the stored canonical path unchanged, so a location that was replaced by
 * a symlink, or moved, is refused instead of scanning wherever it now points. Unexpected errors
 * are rethrown (fail closed).
 */
async function checkLocation(location: string): Promise<ScanFailure | null> {
  let canonical: string;
  try {
    canonical = await realpath(location);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (MISSING_PATH_ERRORS.has(code)) {
      return failure('path-not-found', 'The registered directory no longer exists.');
    }
    if (DENIED_PATH_ERRORS.has(code)) {
      return failure('permission-denied', 'DirectiveBench cannot access the registered directory.');
    }
    throw error;
  }
  if (canonical !== location) return locationChanged();
  if (!(await stat(canonical)).isDirectory()) {
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
 * Executes a `repository-scan` job (SPEC-102, SPEC-105 FR-105-02…07, FR-105-17): walks the
 * registered local directory with `discoverArtifacts` and stores what it finds.
 *
 * The scan reads the working tree as it is on disk — for `local-git` too — and runs no process
 * at all, so no git hook, filter, fsmonitor or package script can run; discovered files are read
 * as bytes and parsed as text, never executed. `.git/` and `node_modules/` are skipped, symlinks
 * are never followed, and nothing outside the registered location is read: the location must
 * still resolve to itself. A scan that cannot run records `sync_status = 'error'` and returns a
 * typed failure; per-artifact discovery errors are part of a successful result.
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
    });
  } catch (error) {
    if (options.signal.aborted) throw new ScanCancelledError('Scan was cancelled');
    if (error instanceof DiscoveryRootChangedError) return fail(locationChanged());
    const message = error instanceof Error ? error.message : String(error);
    return fail(failure('scan-failed', redactSecrets(`The scan failed: ${message}`)));
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
    throw error;
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
    durationMs: Math.round(performance.now() - started),
  };
}
