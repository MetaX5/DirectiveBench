import { rm } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DISCOVERY_LIMITS,
  DiscoveryLimitError,
  discoverArtifactsInTree,
  isBinary,
  parseRepositoryUrl,
  redactSecrets,
  selectCandidateFiles,
  type BinaryTreeFile,
} from '@directivebench/core';
import {
  MAX_REPORTED_SCAN_ERRORS,
  markRepositoryScanFailed,
  registerHostedRepository,
  type DatabaseHandle,
  type RepositoryRecord,
  type RepositoryRegistrationResult,
  type RepositoryScanResult,
} from '@directivebench/database';
import {
  CACHE_SIZE_POLL_INTERVAL_MS,
  HOSTED_CACHE_LIMIT_BYTES,
  HOSTED_GIT_TIMEOUTS,
  GitCancelledError,
  cacheFailure,
  checkGitVersion,
  detectDefaultBranch,
  ensurePrivateDirectory,
  fetchBlobs,
  fetchSnapshot,
  isSafeBranchName,
  listSnapshot,
  readBlobs,
  resolveCaBundle,
  type HostedGitContext,
  type HostedGitFailure,
  type HostedGitTimeouts,
  type HostedGitTransport,
  type SnapshotEntry,
} from './hosted-git';
import { findGitExecutable } from './repository-registration';
import { ScanCancelledError, storeScanResults, toScannedArtifact } from './repository-scan';

export interface HostedRepositoryOptions {
  /** The runner's environment; hosted git takes only allowlisted variables from it. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** `<dataDir>/cache`: holds `repos/<repositoryId>.git` and git's empty `HOME`. */
  cacheDir: string;
  transport: HostedGitTransport;
  /** Overrides of {@link HOSTED_GIT_TIMEOUTS}. */
  timeouts?: Partial<HostedGitTimeouts>;
  /** Default {@link HOSTED_CACHE_LIMIT_BYTES}. */
  cacheLimitBytes?: number;
  /** Default {@link CACHE_SIZE_POLL_INTERVAL_MS}. */
  cacheSizePollIntervalMs?: number;
  /** Default {@link HOSTED_READ_BATCH_BYTES}. */
  readBatchBytes?: number;
}

/**
 * Checks the CA bundle setting, locates git, checks its version and prepares the private cache
 * layout (0700): the `repos` directory and an empty directory used as git's `HOME`. A cache path
 * containing the path list delimiter is refused: git splits `GIT_CEILING_DIRECTORIES` on it, so the ceiling that stops
 * repository discovery would not hold (fail closed).
 */
async function prepare(
  options: HostedRepositoryOptions,
): Promise<{ context: HostedGitContext; reposDir: string } | HostedGitFailure> {
  if (resolve(options.cacheDir).includes(delimiter)) {
    return {
      ok: false,
      code: 'git-failed',
      message: `GitHub repositories need a data directory whose path contains no "${delimiter}": git would read that path as a list. Use a data directory without it.`,
    };
  }
  const ca = await resolveCaBundle(options.env);
  if (!ca.ok) return ca;
  const git = await findGitExecutable(options.env);
  if (!git) return { ok: false, code: 'git-not-installed', message: 'git was not found on PATH.' };
  const home = join(options.cacheDir, 'git-home');
  const reposDir = join(options.cacheDir, 'repos');
  for (const dir of [options.cacheDir, home, reposDir]) await ensurePrivateDirectory(dir);
  const context: HostedGitContext = {
    git,
    env: options.env,
    home,
    caBundle: ca.caBundle,
    transport: options.transport,
    signal: options.signal,
    timeouts: { ...HOSTED_GIT_TIMEOUTS, ...options.timeouts },
    cacheLimitBytes: options.cacheLimitBytes ?? HOSTED_CACHE_LIMIT_BYTES,
    cacheSizePollIntervalMs: options.cacheSizePollIntervalMs ?? CACHE_SIZE_POLL_INTERVAL_MS,
  };
  const tooOld = await checkGitVersion(context);
  return tooOld ?? { context, reposDir };
}

/** The fixed message of an error without an errno code in the git and cache steps (fail closed). */
const UNEXPECTED_HOSTED_FAILURE =
  'The GitHub step failed unexpectedly; nothing was stored. Try again, and report the problem if it persists.';

/**
 * Runs the git and cache steps of a hosted job and turns an error they throw — DirectiveBench's
 * own cache below `<dataDir>/cache` that cannot be created, measured, read or removed — into
 * {@link cacheFailure}, a fixed message with the error code (fail closed, SPEC-105 §13); an error
 * without an errno code gets {@link UNEXPECTED_HOSTED_FAILURE} instead. A
 * cancelled or shut-down job stays a cancellation: git's {@link GitCancelledError} is rethrown,
 * and so is any error once the job's signal has fired.
 */
async function onCacheError<T>(
  signal: AbortSignal,
  steps: () => Promise<T>,
): Promise<T | HostedGitFailure> {
  try {
    return await steps();
  } catch (error) {
    if (error instanceof GitCancelledError) throw error;
    if (signal.aborted) throw new GitCancelledError('git was stopped: the job was cancelled');
    // A file-system error carries an errno code (`EACCES`); Node's own `ERR_*` codes (an invalid
    // argument, …) and errors without a code are not the cache's fault.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (typeof code === 'string' && !code.startsWith('ERR_')) {
      return cacheFailure(error);
    }
    return { ok: false, code: 'git-failed', message: UNEXPECTED_HOSTED_FAILURE };
  }
}

/**
 * Executes the `repository-registration` job of a URL (SPEC-104 FR-104-02, FR-104-07): asks the
 * remote for its default branch with `ls-remote` — nothing is downloaded, no credential is used
 * and no prompt can appear — and stores the repository with provider `github`, or returns the one
 * already registered at that URL (FR-104-04). A repository that needs credentials or does not exist
 * is rejected as "not found or not public" and stores nothing (FR-104-12, D06).
 */
export async function registerHostedUrl(
  handle: DatabaseHandle,
  url: string,
  options: HostedRepositoryOptions,
): Promise<Exclude<RepositoryRegistrationResult, { code: 'confirmation-required' }>> {
  const parsed = parseRepositoryUrl(url);
  if (!parsed.ok) return { ok: false, code: 'invalid-url', message: parsed.message };
  const detected = await onCacheError(options.signal, async () => {
    const prepared = await prepare(options);
    if (!('context' in prepared)) return prepared;
    return detectDefaultBranch(prepared.context, parsed.location);
  });
  if (!detected.ok) return detected;
  const { repository, created } = await registerHostedRepository(handle.db, {
    provider: parsed.provider,
    name: parsed.name,
    location: parsed.location,
    defaultBranch: detected.defaultBranch,
  });
  return { ok: true, repositoryId: repository.id, created };
}

type ScanFailure = Extract<RepositoryScanResult, { ok: false }>;

/** IDs DirectiveBench creates (`repo_…`); anything else never becomes part of a cache path. */
const REPOSITORY_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Most bytes of blobs one `cat-file --batch` of step 5 reads, so only one batch of binary content
 * is held at a time (SPEC-105 §9.1). Each blob is at most the largest per-file limit (5 MiB).
 */
export const HOSTED_READ_BATCH_BYTES = 32 * 1024 * 1024;

/**
 * Step 5 in batches of at most `batchLimit` bytes ({@link HOSTED_READ_BATCH_BYTES}): a binary
 * blob (FR-102-17) is kept only as its size, since discovery skips it, and only the text blobs
 * count toward `maxScanBytes` — the content the scan holds until discovery. Each text blob counts
 * once, however many paths share it; discovery then applies the limit to what it keeps.
 */
async function readCandidateBlobs(
  context: HostedGitContext,
  cacheDir: string,
  blobs: ReadonlyMap<string, number>,
  batchLimit: number,
): Promise<{ ok: true; contents: Map<string, Buffer | BinaryTreeFile> } | ScanFailure> {
  const batches: Map<string, number>[] = [];
  let batch = new Map<string, number>();
  let batchBytes = 0;
  for (const [oid, size] of blobs) {
    if (batch.size > 0 && batchBytes + size > batchLimit) {
      batches.push(batch);
      batch = new Map();
      batchBytes = 0;
    }
    batch.set(oid, size);
    batchBytes += size;
  }
  batches.push(batch);
  const contents = new Map<string, Buffer | BinaryTreeFile>();
  let textBytes = 0;
  for (const next of batches) {
    const read = await readBlobs(context, cacheDir, next);
    if (!read.ok) return read;
    for (const [oid, bytes] of read.contents) {
      if (isBinary(bytes)) {
        contents.set(oid, { binary: true, size: bytes.length });
        continue;
      }
      textBytes += bytes.length;
      if (textBytes > DISCOVERY_LIMITS.maxScanBytes) {
        return {
          ok: false,
          code: 'scan-failed',
          message: `Discovery aborted: the candidate text files exceed the limit of ${DISCOVERY_LIMITS.maxScanBytes} bytes per scan`,
        };
      }
      contents.set(oid, bytes);
    }
  }
  return { ok: true, contents };
}

/**
 * Steps 1–5 of SPEC-105 §9.1 for one repository: prepares the cache, fetches the snapshot, lists
 * and selects the candidate files, downloads exactly their blobs and reads those within the
 * per-file limit. A failure is returned, not recorded: the caller records it once. Errors of the
 * cache itself are thrown (see {@link onCacheError}).
 */
async function fetchCandidates(
  options: HostedRepositoryOptions,
  repository: { id: string; location: string; branch: string },
): Promise<
  | {
      ok: true;
      commitSha: string;
      entries: SnapshotEntry[];
      contents: Map<string, Buffer | number | BinaryTreeFile>;
    }
  | ScanFailure
> {
  const prepared = await prepare(options);
  if (!('context' in prepared)) return prepared;
  const { context } = prepared;
  const cacheDir = join(prepared.reposDir, `${repository.id}.git`);
  const target = { location: repository.location, branch: repository.branch, cacheDir };

  const snapshot = await fetchSnapshot(context, target);
  if (!snapshot.ok) return snapshot;
  // A git step that fails on the cache (listing, blob download, read) deletes it: it may be over
  // the size limit or inconsistent, and the next scan starts from a fresh clone (SPEC-105 §13).
  const drop = async (result: ScanFailure): Promise<ScanFailure> => {
    await rm(cacheDir, { recursive: true, force: true });
    return result;
  };
  const listing = await listSnapshot(context, cacheDir, snapshot.commitSha);
  if (!listing.ok) return drop(listing);

  let selected: string[];
  try {
    selected = selectCandidateFiles(listing.entries);
  } catch (error) {
    // Too many candidates (FR-102-16) or a crafted path: nothing is downloaded.
    const reason =
      error instanceof DiscoveryLimitError ? error.message : 'The repository tree is invalid.';
    return { ok: false, code: 'scan-failed', message: reason };
  }
  const oidOf = new Map(listing.entries.map((entry) => [entry.path, entry.oid]));
  const oids = [...new Set(selected.map((path) => String(oidOf.get(path))))].sort();
  const blobs = await fetchBlobs(context, target, oids);
  if (!blobs.ok) return drop(blobs);

  // Blobs above the largest per-file limit are never loaded: discovery only needs their size.
  const perFileLimit = Math.max(
    DISCOVERY_LIMITS.maxPrimaryFileBytes,
    DISCOVERY_LIMITS.maxSupportingFileBytes,
  );
  const loadable = new Map([...blobs.sizes].filter(([, size]) => size <= perFileLimit));
  const read = await readCandidateBlobs(
    context,
    cacheDir,
    loadable,
    options.readBatchBytes ?? HOSTED_READ_BATCH_BYTES,
  );
  // Too much text is about the content (the cache stays valid); a failed read deletes the cache.
  if (!read.ok) return read.code === 'scan-failed' ? read : drop(read);
  const contents = new Map<string, Buffer | number | BinaryTreeFile>();
  for (const path of selected) {
    const oid = String(oidOf.get(path));
    contents.set(path, read.contents.get(oid) ?? Number(blobs.sizes.get(oid)));
  }
  return { ok: true, commitSha: snapshot.commitSha, entries: listing.entries, contents };
}

/**
 * Executes the `repository-scan` job of a hosted repository (SPEC-105 FR-105-05/06, §9.1): fetches
 * the commit and trees of the branch into the bare, blob-less, shallow cache
 * `<cacheDir>/repos/<repositoryId>.git`, lists the commit, selects the candidate files with the
 * discovery rules (SPEC-102), downloads exactly their blobs, reads them from the cache and stores
 * what discovery finds with the commit recorded on every occurrence. No working tree or sparse
 * checkout exists, and nothing from the repository runs. Every failure records `sync_status =
 * 'error'` with a message free of credentials and absolute paths — a cache below `<dataDir>/cache`
 * that cannot be used included (issue #57); a cancellation records nothing.
 */
export async function scanHostedRepository(
  handle: DatabaseHandle,
  job: { jobId: string; repository: RepositoryRecord },
  options: HostedRepositoryOptions,
): Promise<RepositoryScanResult> {
  const started = performance.now();
  const { repository } = job;
  const fail = async (result: ScanFailure): Promise<ScanFailure> => {
    await markRepositoryScanFailed(handle.db, repository.id, result.message);
    return result;
  };
  const parsed = parseRepositoryUrl(repository.location);
  if (!parsed.ok || parsed.location !== repository.location || !REPOSITORY_ID.test(repository.id)) {
    return fail({
      ok: false,
      code: 'scan-failed',
      message: 'The stored repository location is invalid.',
    });
  }
  const branch = repository.selectedBranch ?? repository.defaultBranch;
  if (branch === null || !isSafeBranchName(branch)) {
    return fail({
      ok: false,
      code: 'branch-not-found',
      message:
        'No default branch was detected for this repository (it may be empty). Register its URL again once it has commits: that detects the default branch again.',
    });
  }
  const fetched = await onCacheError(options.signal, () =>
    fetchCandidates(options, { location: repository.location, branch, id: repository.id }),
  );
  if (!fetched.ok) return fail(fetched);
  const { commitSha, entries, contents } = fetched;

  let discovery;
  try {
    discovery = await discoverArtifactsInTree(entries, contents, {
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw new ScanCancelledError('Scan was cancelled');
    // A per-scan limit (FR-102-16) or a file whose content is missing: core's messages name a
    // limit or a repository-relative path, never file contents.
    return fail({
      ok: false,
      code: 'scan-failed',
      message: redactSecrets((error as Error).message),
    });
  }
  const stored = await storeScanResults(handle, {
    jobId: job.jobId,
    repositoryId: repository.id,
    artifacts: discovery.artifacts.map(toScannedArtifact),
    commitSha,
    signal: options.signal,
  });
  if (!stored.ok) return stored;
  return {
    ok: true,
    scannedFiles: discovery.scannedFiles,
    discovered: discovery.artifacts.length,
    createdArtifacts: stored.summary.createdArtifacts,
    createdVersions: stored.summary.createdVersions,
    warningCount: discovery.artifacts.reduce((sum, a) => sum + a.warnings.length, 0),
    errorCount: discovery.errors.length,
    errors: discovery.errors.slice(0, MAX_REPORTED_SCAN_ERRORS),
    skippedUserLevelFolders: [],
    commitSha,
    durationMs: Math.round(performance.now() - started),
  };
}
