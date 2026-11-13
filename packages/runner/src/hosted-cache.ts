import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listOrphanedRepositoryCaches, type DatabaseHandle } from '@directivebench/database';
import { errnoCode } from './git-process';
import type { RunnerLogger } from './runner';

/**
 * The repository ids DirectiveBench creates (`createId('repo')`: `repo_` plus 12 random bytes in
 * base64url). A hosted scan refuses any other id, so every cache it can create is one the sweep
 * recognises (SPEC-105 FR-105-19, issue 59 J6).
 */
export const REPOSITORY_ID = /^repo_[A-Za-z0-9_-]{16}$/;

/** The name of a hosted repository's cache in `<cacheDir>/repos`; the group is the id. */
export const REPOSITORY_CACHE_NAME = /^(repo_[A-Za-z0-9_-]{16})\.git$/;

/** How often a running runner deletes the caches of removed repositories (SPEC-105 FR-105-19). */
export const ORPHANED_CACHE_SWEEP_INTERVAL_MS = 60_000;

/** The log code of a cache whose canonical path is not directly below the canonical root. */
const OUTSIDE_CACHE = 'OUTSIDE_CACHE';

export interface RepositoryCacheListing {
  /** The canonical `<cacheDir>/repos`. */
  root: string;
  /** Ids of the entries named `<id>.git` that are real directories (never a symlink), sorted. */
  caches: string[];
  /**
   * Names of every other entry (other names, files, symlinks), sorted: DirectiveBench did not
   * create them and never deletes them.
   */
  unknown: string[];
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Lists `<cacheDir>/repos` without following or changing anything (SPEC-105 FR-105-19, J4, J5):
 * the root is resolved once, so a data directory or `cache` behind a symlink works; an entry is a
 * cache only when its name matches {@link REPOSITORY_CACHE_NAME} and `lstat` shows a real
 * directory. Returns null when there is no `repos` directory; throws any other error (a root that
 * is not a directory or cannot be read). An entry that disappears while it is checked is skipped.
 */
export async function listRepositoryCaches(
  cacheDir: string,
): Promise<RepositoryCacheListing | null> {
  let root: string;
  try {
    root = await realpath(join(cacheDir, 'repos'));
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
  const caches: string[] = [];
  const unknown: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    const id = REPOSITORY_CACHE_NAME.exec(name)?.[1];
    if (id === undefined) {
      unknown.push(name);
      continue;
    }
    let directory: boolean;
    try {
      directory = (await lstat(join(root, name))).isDirectory();
    } catch (error) {
      if (isAbsent(error)) continue;
      throw error;
    }
    if (directory) caches.push(id);
    else unknown.push(name);
  }
  return { root, caches, unknown };
}

/**
 * Deletes one orphaned cache. The path is rebuilt from the id the database confirmed; just before
 * the deletion its canonical parent must still be the canonical root (fail closed: an entry
 * replaced by a link to elsewhere is refused). `rm` removes links inside the tree as links. An
 * entry that is already gone counts as deleted: another process may have won the race.
 */
async function deleteCache(root: string, repositoryId: string): Promise<void> {
  const target = join(root, `${repositoryId}.git`);
  try {
    if (dirname(await realpath(target)) !== root) {
      throw Object.assign(new Error('The cache is not directly below the cache root'), {
        code: OUTSIDE_CACHE,
      });
    }
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
}

/** The error code of a file-system or database error (Drizzle wraps the SQLite error). */
function failureCode(error: unknown): string {
  return errnoCode(error instanceof Error && error.cause !== undefined ? error.cause : error);
}

export interface OrphanedCacheSweep {
  handle: DatabaseHandle;
  /** `<dataDir>/cache` */
  cacheDir: string;
  logger: RunnerLogger;
  /**
   * Ids whose deletion failed and was logged in this runner process: a later failure of the same
   * id is not logged again, a later success is (and removes the id).
   */
  reportedFailures: Set<string>;
}

/**
 * Deletes the caches of repositories that no longer exist (SPEC-105 FR-105-19, issue 59): the
 * entries {@link listRepositoryCaches} reports as caches whose ids
 * `listOrphanedRepositoryCaches` returns. Never rejects: a listing or database error is logged as
 * `cache-sweep-failed`, a failed deletion as `cache-delete-failed` (once per id), each with the
 * error code only, never a path; the next sweep retries.
 */
export async function sweepOrphanedCaches(sweep: OrphanedCacheSweep): Promise<void> {
  const { handle, cacheDir, logger, reportedFailures } = sweep;
  let root: string;
  let orphans: string[];
  try {
    const listing = await listRepositoryCaches(cacheDir);
    if (listing === null) return;
    root = listing.root;
    orphans = await listOrphanedRepositoryCaches(handle, listing.caches);
  } catch (error) {
    const code = failureCode(error);
    logger.error(`The sweep of cached GitHub downloads failed (${code})`, {
      event: 'cache-sweep-failed',
      code,
    });
    return;
  }
  for (const repositoryId of orphans) {
    try {
      await deleteCache(root, repositoryId);
    } catch (error) {
      if (reportedFailures.has(repositoryId)) continue;
      reportedFailures.add(repositoryId);
      const code = failureCode(error);
      logger.error(
        `The cached download of removed repository ${repositoryId} could not be deleted (${code}); it is retried at the next sweep`,
        { event: 'cache-delete-failed', repositoryId, code },
      );
      continue;
    }
    reportedFailures.delete(repositoryId);
    logger.info(`Deleted the cached download of removed repository ${repositoryId}`, {
      event: 'cache-deleted',
      repositoryId,
    });
  }
}
