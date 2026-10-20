import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DISCOVERY_LIMITS,
  DiscoveryLimitError,
  discoverArtifactsInTree,
  parseRepositoryUrl,
  redactSecrets,
  selectCandidateFiles,
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
  checkGitVersion,
  detectDefaultBranch,
  ensurePrivateDirectory,
  fetchBlobs,
  fetchSnapshot,
  isSafeBranchName,
  listSnapshot,
  readBlobs,
  type HostedGitContext,
  type HostedGitFailure,
  type HostedGitTimeouts,
  type HostedGitTransport,
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
}

/**
 * Locates git, checks its version and prepares the private cache layout (0700): the `repos`
 * directory and an empty directory used as git's `HOME`.
 */
async function prepare(
  options: HostedRepositoryOptions,
): Promise<{ context: HostedGitContext; reposDir: string } | HostedGitFailure> {
  const git = await findGitExecutable(options.env);
  if (!git) return { ok: false, code: 'git-not-installed', message: 'git was not found on PATH.' };
  const home = join(options.cacheDir, 'git-home');
  const reposDir = join(options.cacheDir, 'repos');
  for (const dir of [options.cacheDir, home, reposDir]) await ensurePrivateDirectory(dir);
  const context: HostedGitContext = {
    git,
    env: options.env,
    home,
    transport: options.transport,
    signal: options.signal,
    timeouts: { ...HOSTED_GIT_TIMEOUTS, ...options.timeouts },
    cacheLimitBytes: options.cacheLimitBytes ?? HOSTED_CACHE_LIMIT_BYTES,
    cacheSizePollIntervalMs: options.cacheSizePollIntervalMs ?? CACHE_SIZE_POLL_INTERVAL_MS,
  };
  const tooOld = await checkGitVersion(context, home);
  return tooOld ?? { context, reposDir };
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
  const prepared = await prepare(options);
  if (!('context' in prepared)) return prepared;
  const detected = await detectDefaultBranch(
    prepared.context,
    parsed.location,
    prepared.context.home,
  );
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
 * Executes the `repository-scan` job of a hosted repository (SPEC-105 FR-105-05/06, §9.1): fetches
 * the commit and trees of the branch into the bare, blob-less, shallow cache
 * `<cacheDir>/repos/<repositoryId>.git`, lists the commit, selects the candidate files with the
 * discovery rules (SPEC-102), downloads exactly their blobs, reads them from the cache and stores
 * what discovery finds with the commit recorded on every occurrence. No working tree or sparse
 * checkout exists, and nothing from the repository runs. Every failure records `sync_status =
 * 'error'` with a message free of credentials and absolute paths.
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
        'No default branch was detected for this repository (it may be empty). Register it again once it has commits.',
    });
  }
  const prepared = await prepare(options);
  if (!('context' in prepared)) return fail(prepared);
  const { context } = prepared;
  const cacheDir = join(prepared.reposDir, `${repository.id}.git`);
  const target = { location: repository.location, branch, cacheDir, parentDir: prepared.reposDir };

  const snapshot = await fetchSnapshot(context, target);
  if (!snapshot.ok) return fail(snapshot);
  const listing = await listSnapshot(context, cacheDir, snapshot.commitSha);
  if (!listing.ok) return fail(listing);

  let selected: string[];
  try {
    selected = selectCandidateFiles(listing.entries);
  } catch (error) {
    // Too many candidates (FR-102-16) or a crafted path: nothing is downloaded.
    const reason =
      error instanceof DiscoveryLimitError ? error.message : 'The repository tree is invalid.';
    return fail({ ok: false, code: 'scan-failed', message: reason });
  }
  const oidOf = new Map(listing.entries.map((entry) => [entry.path, entry.oid]));
  const oids = [...new Set(selected.map((path) => String(oidOf.get(path))))].sort();
  const blobs = await fetchBlobs(context, target, oids);
  if (!blobs.ok) return fail(blobs);

  // Blobs above the largest per-file limit are never loaded: discovery only needs their size.
  const perFileLimit = Math.max(
    DISCOVERY_LIMITS.maxPrimaryFileBytes,
    DISCOVERY_LIMITS.maxSupportingFileBytes,
  );
  const loadable = new Map([...blobs.sizes].filter(([, size]) => size <= perFileLimit));
  const loadBytes = [...loadable.values()].reduce((sum, size) => sum + size, 0);
  if (loadBytes > DISCOVERY_LIMITS.maxScanBytes) {
    return fail({
      ok: false,
      code: 'scan-failed',
      message: `Discovery aborted: the candidate files exceed the limit of ${DISCOVERY_LIMITS.maxScanBytes} bytes per scan`,
    });
  }
  const read = await readBlobs(context, cacheDir, loadable);
  if (!read.ok) return fail(read);
  const contents = new Map<string, Buffer | number>();
  for (const path of selected) {
    const oid = String(oidOf.get(path));
    contents.set(path, read.contents.get(oid) ?? Number(blobs.sizes.get(oid)));
  }

  let discovery;
  try {
    discovery = await discoverArtifactsInTree(listing.entries, contents, {
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
    commitSha: snapshot.commitSha,
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
    commitSha: snapshot.commitSha,
    durationMs: Math.round(performance.now() - started),
  };
}
