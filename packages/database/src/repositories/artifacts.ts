import { and, desc, eq, exists, gte, inArray, lt, max, or, sql } from 'drizzle-orm';
import type { ArtifactBundle, ArtifactFormat, ArtifactType } from '@directivebench/core';
import { createId, hashManifest, nowIso, sha256, slugify } from '@directivebench/core';
import { withTransaction, type Database, type DatabaseHandle } from '../client';
import { JobNoLongerRunningError, NotFoundError } from './jobs';
import {
  artifactBenchmarkAssignments,
  artifactCategories,
  artifactOccurrences,
  artifacts,
  artifactVersions,
  benchmarkRuns,
  benchmarkSuites,
  categories,
  jobs,
  repositories,
  type StoredArtifactFile,
} from '../schema';

export type RepositoryProvider = (typeof repositories.$inferSelect)['provider'];

export interface RepositoryRef {
  provider: RepositoryProvider;
  name: string;
  location: string;
}

/** A file to import: `sha256` and `size` are accepted for convenience and ignored. */
export type ImportArtifactFile = Pick<StoredArtifactFile, 'path' | 'content'> &
  Partial<Pick<StoredArtifactFile, 'sha256' | 'size'>>;

/** Matches an unpaired UTF-16 surrogate: such a string has no exact UTF-8 encoding. */
const LONE_SURROGATE = /\p{Surrogate}/u;

export interface ImportArtifactInput {
  repository: RepositoryRef;
  /** Repository-relative path of the artifact (directory for skills). */
  path: string;
  slug: string;
  name: string;
  type: ArtifactType;
  description: string | null;
  format: ArtifactFormat;
  primaryFile: string;
  /**
   * Files of the version. Only `path` and `content` are used: `sha256` and `size` are always
   * recomputed from `content` (SPEC-103 §12), so a caller cannot pair one file's content with
   * another file's hash. They stay optional so loader output can be passed through unchanged.
   */
  files: ImportArtifactFile[];
  parsedMetadata: Record<string, unknown>;
  commitSha?: string | null;
}

export interface ImportArtifactResult {
  artifactId: string;
  versionId: string;
  version: number;
  createdVersion: boolean;
}

export async function upsertRepository(db: Database, ref: RepositoryRef): Promise<string> {
  const existing = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.provider, ref.provider), eq(repositories.location, ref.location)))
    .get();
  if (existing) return existing.id;
  const id = createId('repo');
  const now = nowIso();
  await db.insert(repositories).values({
    id,
    provider: ref.provider,
    name: ref.name,
    location: ref.location,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * How a version finds its logical artifact (SPEC-101 §8.3).
 * - `slug` — the bootstrap rule for bundled examples, whose location changes between installs:
 *   an artifact that already occurs in a repository of the same provider and has the same slug
 *   (or, when its slug got a suffix, the same name and type).
 * - `location` — repository content: the artifact of the occurrence at the same repository and
 *   path (rule 1), never a slug match, so same-named artifacts stay separate (rules 2–3 are
 *   issue #20).
 * A new artifact takes the first free slug, suffixed `-2`, `-3`… when taken (rule 4, SPEC-105
 * FR-105-16 c), so a scanned skill never attaches to the bundled demo skill and vice versa.
 */
type ArtifactIdentity = 'slug' | 'location';

/** The fields of a version write that do not depend on where the artifact is stored. */
type VersionContent = Omit<ImportArtifactInput, 'repository' | 'slug' | 'commitSha'>;

/**
 * Each file's `sha256` and `size` and the manifest content hash, always computed from the stored
 * content (SPEC-103 FR-103-03, FR-103-04, §12); callers cannot supply them. Content is UTF-8 text
 * (SPEC-102 FR-102-17), so hashing its UTF-8 encoding hashes the source bytes; content that is not
 * well-formed Unicode is rejected before anything is written.
 */
function recomputeFiles(input: Pick<VersionContent, 'files'>): {
  files: StoredArtifactFile[];
  contentHash: string;
} {
  const files: StoredArtifactFile[] = input.files.map(({ path, content }) => {
    // Encoding replaces a lone surrogate with U+FFFD, so two different paths or contents would
    // share one hash (and one version). Fail closed instead.
    if (LONE_SURROGATE.test(path) || LONE_SURROGATE.test(content)) {
      throw new Error(`File path or content is not well-formed Unicode: ${JSON.stringify(path)}`);
    }
    const bytes = Buffer.from(content, 'utf8');
    return { path, sha256: sha256(bytes), size: bytes.length, content };
  });
  return { files, contentHash: hashManifest(files) };
}

/**
 * Allocates rule-4 slugs — the first free of `base`, `base-2`, `base-3`, … — for the new artifacts
 * of one transaction. The slugs a base can collide with (`base` and every `base-…`) are read once
 * per base, and later candidates are checked in memory with a per-base cursor, so N same-named
 * artifacts (a monorepo's nested AGENTS.md files) cost one query instead of about N²/2 (final
 * Codex review of PR #44). The memory is only valid inside the transaction it was created for:
 * `BEGIN IMMEDIATE` keeps other writers out, and every artifact inserted meanwhile takes its slug
 * from this allocator, which records it in the set all bases share.
 */
type SlugAllocator = (base: string) => Promise<string>;

function slugAllocator(db: Database): SlugAllocator {
  const taken = new Set<string>();
  /** Per base read so far, the next suffix to try; every lower one is taken. */
  const nextSuffix = new Map<string, number>();
  return async (base) => {
    let suffix = nextSuffix.get(base);
    if (suffix === undefined) {
      // `base-` up to, not including, `base.`: '.' follows '-', so under the column's BINARY
      // collation the range holds exactly the slugs that start with `base-`, with no LIKE pattern
      // to escape, and it is a range scan of the unique slug index.
      const rows = await db
        .select({ slug: artifacts.slug })
        .from(artifacts)
        .where(
          or(
            eq(artifacts.slug, base),
            and(gte(artifacts.slug, `${base}-`), lt(artifacts.slug, `${base}.`)),
          ),
        );
      for (const row of rows) taken.add(row.slug);
      suffix = 1;
    }
    let candidate = suffix === 1 ? base : `${base}-${suffix}`;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    taken.add(candidate);
    nextSuffix.set(base, suffix + 1);
    return candidate;
  };
}

interface VersionTarget {
  repositoryId: string;
  provider: RepositoryProvider;
  identity: ArtifactIdentity;
  slug: string;
  commitSha: string | null;
}

/** Finds the logical artifact of a version write, without creating it. */
async function findArtifact(
  db: Database,
  target: VersionTarget,
  { path, name, type }: Pick<VersionContent, 'path' | 'name' | 'type'>,
): Promise<{ id: string } | undefined> {
  if (target.identity === 'location') {
    return db
      .select({ id: artifactOccurrences.artifactId })
      .from(artifactOccurrences)
      .where(
        and(
          eq(artifactOccurrences.repositoryId, target.repositoryId),
          eq(artifactOccurrences.path, path),
        ),
      )
      .get();
  }
  return db
    .select({ id: artifacts.id })
    .from(artifacts)
    .innerJoin(artifactOccurrences, eq(artifactOccurrences.artifactId, artifacts.id))
    .innerJoin(repositories, eq(artifactOccurrences.repositoryId, repositories.id))
    .where(
      and(
        eq(repositories.provider, target.provider),
        // The slug, or — when that slug was taken and the artifact got a suffix — name and type.
        or(
          eq(artifacts.slug, target.slug),
          and(eq(artifacts.name, name), eq(artifacts.type, type)),
        ),
      ),
    )
    .orderBy(artifacts.createdAt, artifacts.id)
    .get();
}

/**
 * Writes one observed artifact inside the caller's transaction: creates the logical artifact on
 * first sight, adds an immutable version only when the content hash is new for that artifact,
 * and points the occurrence at it. User-managed metadata (notes, tags, categories, benchmark
 * assignments) is never touched.
 */
async function writeArtifactVersion(
  db: Database,
  allocateSlug: SlugAllocator,
  target: VersionTarget,
  input: VersionContent,
  recomputed: { files: StoredArtifactFile[]; contentHash: string },
): Promise<ImportArtifactResult & { createdArtifact: boolean }> {
  const now = nowIso();
  const { repositoryId, commitSha } = target;
  const { files, contentHash } = recomputed;

  let artifact = await findArtifact(db, target, input);
  const createdArtifact = !artifact;
  if (!artifact) {
    artifact = { id: createId('art') };
    await db.insert(artifacts).values({
      id: artifact.id,
      slug: await allocateSlug(target.slug),
      name: input.name,
      type: input.type,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    // Source-derived fields follow the source; user-managed fields are left untouched.
    await db
      .update(artifacts)
      .set({ name: input.name, description: input.description, updatedAt: now })
      .where(eq(artifacts.id, artifact.id));
  }

  let version = await db
    .select({ id: artifactVersions.id, version: artifactVersions.version })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.artifactId, artifact.id),
        eq(artifactVersions.contentHash, contentHash),
      ),
    )
    .get();
  let createdVersion = false;
  if (!version) {
    const current = await db
      .select({ value: max(artifactVersions.version) })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifact.id))
      .get();
    version = { id: createId('artv'), version: (current?.value ?? 0) + 1 };
    await db.insert(artifactVersions).values({
      id: version.id,
      artifactId: artifact.id,
      version: version.version,
      contentHash,
      format: input.format,
      primaryFile: input.primaryFile,
      files,
      parsedMetadata: input.parsedMetadata,
      sourceRepositoryId: repositoryId,
      sourcePath: input.path,
      sourceCommitSha: commitSha,
      createdAt: now,
    });
    createdVersion = true;
  }

  const occurrence = await db
    .select({ id: artifactOccurrences.id })
    .from(artifactOccurrences)
    .where(
      and(
        eq(artifactOccurrences.repositoryId, repositoryId),
        eq(artifactOccurrences.path, input.path),
      ),
    )
    .get();
  if (occurrence) {
    await db
      .update(artifactOccurrences)
      .set({
        artifactId: artifact.id,
        latestVersionId: version.id,
        commitSha,
        status: 'active',
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(artifactOccurrences.id, occurrence.id));
  } else {
    await db.insert(artifactOccurrences).values({
      id: createId('occ'),
      artifactId: artifact.id,
      repositoryId,
      path: input.path,
      latestVersionId: version.id,
      commitSha,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    artifactId: artifact.id,
    versionId: version.id,
    version: version.version,
    createdVersion,
    createdArtifact,
  };
}

/**
 * Records an artifact found in a source (bundled examples). Creates the logical artifact on first
 * sight (matched by slug), adds an immutable version only when the content hash is new, and
 * points the occurrence at it. Hashes are recomputed from the content (see `recomputeFiles`).
 * User-managed metadata (notes, tags, categories, benchmark assignments) is never touched.
 */
export async function importArtifactVersion(
  handle: DatabaseHandle,
  input: ImportArtifactInput,
): Promise<ImportArtifactResult> {
  const recomputed = recomputeFiles(input);
  return withTransaction(handle, async (db) => {
    const repositoryId = await upsertRepository(db, input.repository);
    const { createdArtifact: _created, ...result } = await writeArtifactVersion(
      db,
      slugAllocator(db),
      {
        repositoryId,
        provider: input.repository.provider,
        identity: 'slug',
        slug: input.slug,
        commitSha: input.commitSha ?? null,
      },
      input,
      recomputed,
    );
    return result;
  });
}

/** One artifact a repository scan discovered (SPEC-102 `DiscoveredArtifact`, as stored). */
export type ScannedArtifactInput = VersionContent;

/**
 * Storing the scan results failed while one artifact was being written (the whole scan
 * transaction is rolled back). `path` is that artifact's repository-relative occurrence path: it
 * says where the write stopped, not why. The cause can be the artifact itself (metadata that
 * cannot be serialised) or the connection (`SQLITE_FULL`, an I/O error, a closed handle); the
 * original error is the `cause`. The message never carries the cause's text, which can hold query
 * parameters, i.e. file contents.
 */
export class ArtifactStoreError extends Error {
  override name = 'ArtifactStoreError';
  constructor(
    readonly path: string,
    options: { cause: unknown },
  ) {
    super('Storing the scan results failed', options);
  }
}

export interface RepositoryScanSummary {
  createdArtifacts: number;
  createdVersions: number;
}

export interface RepositoryScanApplication {
  repositoryId: string;
  /** The `repository-scan` job doing the work; nothing is written unless it is still running. */
  jobId: string;
  artifacts: readonly ScannedArtifactInput[];
  /**
   * The commit the artifacts were read at — a hosted repository's snapshot (SPEC-105 FR-105-06) —
   * recorded on every occurrence, new version and the repository; null for a working-tree scan.
   */
  commitSha: string | null;
  /**
   * The job's abort signal (user cancellation or runner shutdown). It is checked inside the
   * transaction, before anything is written: the transaction may have waited behind another one
   * on the shared connection, and a shutdown records nothing in the `jobs` row to re-check.
   */
  signal: AbortSignal;
}

/**
 * Stores the artifacts a scan of a registered repository discovered, in one transaction
 * (SPEC-105 FR-105-09 subset): every version goes through the same writer as
 * `importArtifactVersion` (hashes recomputed from content, dedup by content hash) with location
 * identity, and the repository records a successful scan (`last_sync_at`, `sync_status = 'ok'`,
 * `sync_error = null`) with the commit read (`last_commit_sha`; null for a working-tree scan, which
 * reads no commit). Occurrences that
 * were not found again are left as they are (removed files are issue #21). The job is re-checked
 * inside the transaction: a scan whose signal was aborted, or that was cancelled or interrupted
 * meanwhile, writes nothing (a `JobNoLongerRunningError`, FR-105-17), and a repository removed
 * meanwhile is a `NotFoundError`. A failure while one artifact is written rolls everything back
 * and is an `ArtifactStoreError` carrying the path where it happened.
 */
export async function applyRepositoryScan(
  handle: DatabaseHandle,
  application: RepositoryScanApplication,
): Promise<RepositoryScanSummary> {
  const { repositoryId, jobId } = application;
  const prepared = application.artifacts.map((input) => ({
    input,
    recomputed: recomputeFiles(input),
  }));
  return withTransaction(handle, async (db) => {
    if (application.signal.aborted) {
      throw new JobNoLongerRunningError(`Job ${jobId} was aborted before its results were stored`);
    }
    const job = await db
      .select({ status: jobs.status, cancelRequestedAt: jobs.cancelRequestedAt })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    if (job?.status !== 'running' || job.cancelRequestedAt !== null) {
      throw new JobNoLongerRunningError(`Job ${jobId} is no longer running`);
    }
    const repository = await db
      .select({ provider: repositories.provider })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .get();
    if (!repository) throw new NotFoundError(`Repository ${repositoryId} not found`);
    const summary: RepositoryScanSummary = { createdArtifacts: 0, createdVersions: 0 };
    const allocateSlug = slugAllocator(db);
    for (const { input, recomputed } of prepared) {
      const result = await writeArtifactVersion(
        db,
        allocateSlug,
        {
          repositoryId,
          provider: repository.provider,
          identity: 'location',
          slug: slugify(input.name),
          commitSha: application.commitSha,
        },
        input,
        recomputed,
      ).catch((error: unknown) => {
        throw new ArtifactStoreError(input.path, { cause: error });
      });
      summary.createdArtifacts += Number(result.createdArtifact);
      summary.createdVersions += Number(result.createdVersion);
    }
    const now = nowIso();
    await db
      .update(repositories)
      .set({
        lastCommitSha: application.commitSha,
        lastSyncAt: now,
        syncStatus: 'ok',
        syncError: null,
        updatedAt: now,
      })
      .where(eq(repositories.id, repositoryId));
    return summary;
  });
}

/**
 * Records a scan that could not run or finish (SPEC-105 FR-105-15): the repository's
 * `sync_status` becomes `error` with the message; its artifacts and occurrences are unchanged.
 */
export async function markRepositoryScanFailed(
  db: Database,
  repositoryId: string,
  message: string,
): Promise<void> {
  await db
    .update(repositories)
    .set({ syncStatus: 'error', syncError: message, updatedAt: nowIso() })
    .where(eq(repositories.id, repositoryId));
}

/** Assigns existing, non-archived categories by slug. Unknown slugs are returned, not created. */
export async function assignCategoriesBySlug(
  db: Database,
  artifactId: string,
  slugs: readonly string[],
): Promise<{ assigned: string[]; unknown: string[] }> {
  if (slugs.length === 0) return { assigned: [], unknown: [] };
  const found = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories)
    .where(and(inArray(categories.slug, [...slugs]), sql`${categories.archivedAt} is null`));
  const now = nowIso();
  for (const category of found) {
    await db
      .insert(artifactCategories)
      .values({ artifactId, categoryId: category.id, createdAt: now })
      .onConflictDoNothing();
  }
  const assigned = found.map((c) => c.slug);
  return { assigned, unknown: slugs.filter((s) => !assigned.includes(s)) };
}

export async function assignBenchmarkSuite(
  db: Database,
  artifactId: string,
  suiteId: string,
): Promise<void> {
  await db
    .insert(artifactBenchmarkAssignments)
    .values({ artifactId, suiteId, createdAt: nowIso() })
    .onConflictDoNothing();
}

/** At most 32 tags per artifact, each at most 64 characters (SPEC-101 FR-101-07). */
export const MAX_ARTIFACT_TAGS = 32;
export const MAX_ARTIFACT_TAG_LENGTH = 64;
/** User notes are at most 10 000 characters (SPEC-101 §11, issue #64). */
export const MAX_ARTIFACT_NOTES_LENGTH = 10_000;

export type AddArtifactTagOutcome = 'added' | 'exists' | 'limit';

/**
 * Adds one already normalised tag. Reading the tags and writing them back is one transaction,
 * so two concurrent adds cannot lose a tag or pass the limit. Throws `NotFoundError` for an
 * unknown artifact.
 */
export async function addArtifactTag(
  handle: DatabaseHandle,
  artifactId: string,
  tag: string,
): Promise<AddArtifactTagOutcome> {
  return withTransaction(handle, async (db) => {
    const tags = await artifactTags(db, artifactId);
    if (tags.includes(tag)) return 'exists';
    if (tags.length >= MAX_ARTIFACT_TAGS) return 'limit';
    await db
      .update(artifacts)
      .set({ tags: [...tags, tag], updatedAt: nowIso() })
      .where(eq(artifacts.id, artifactId));
    return 'added';
  });
}

/** Removes one tag; `false` when the artifact did not have it. Throws `NotFoundError`. */
export async function removeArtifactTag(
  handle: DatabaseHandle,
  artifactId: string,
  tag: string,
): Promise<boolean> {
  return withTransaction(handle, async (db) => {
    const tags = await artifactTags(db, artifactId);
    if (!tags.includes(tag)) return false;
    await db
      .update(artifacts)
      .set({ tags: tags.filter((t) => t !== tag), updatedAt: nowIso() })
      .where(eq(artifacts.id, artifactId));
    return true;
  });
}

async function artifactTags(db: Database, artifactId: string): Promise<string[]> {
  const row = await db
    .select({ tags: artifacts.tags })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .get();
  if (!row) throw new NotFoundError(`Artifact ${artifactId} not found`);
  return row.tags;
}

/** Replaces the notes; `null` clears them. Throws `NotFoundError` for an unknown artifact. */
export async function setArtifactNotes(
  db: Database,
  artifactId: string,
  notes: string | null,
): Promise<void> {
  const updated = await db
    .update(artifacts)
    .set({ notes, updatedAt: nowIso() })
    .where(eq(artifacts.id, artifactId))
    .returning({ id: artifacts.id });
  if (updated.length === 0) throw new NotFoundError(`Artifact ${artifactId} not found`);
}

export type ArtifactSuiteOutcome =
  | { status: 'assigned' | 'already-assigned' | 'unassigned' | 'not-assigned'; suiteName: string }
  | { status: 'missing-artifact' | 'missing-suite' };

/**
 * Assigns a suite from the UI. Unlike `assignBenchmarkSuite`, a deleted artifact or suite is an
 * outcome, not a foreign-key error, and the suite's name comes back for the message. The checks
 * and the insert are one transaction.
 */
export async function assignArtifactSuite(
  handle: DatabaseHandle,
  artifactId: string,
  suiteId: string,
): Promise<ArtifactSuiteOutcome> {
  return withTransaction(handle, async (db) => {
    const artifact = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .get();
    if (!artifact) return { status: 'missing-artifact' };
    const suite = await suiteName(db, suiteId);
    if (suite === null) return { status: 'missing-suite' };
    const inserted = await db
      .insert(artifactBenchmarkAssignments)
      .values({ artifactId, suiteId, createdAt: nowIso() })
      .onConflictDoNothing()
      .returning({ suiteId: artifactBenchmarkAssignments.suiteId });
    return { status: inserted.length ? 'assigned' : 'already-assigned', suiteName: suite };
  });
}

/** Removes an assignment made in the UI or by a CLI run. Runs and results are kept. */
export async function unassignArtifactSuite(
  handle: DatabaseHandle,
  artifactId: string,
  suiteId: string,
): Promise<ArtifactSuiteOutcome> {
  return withTransaction(handle, async (db) => {
    const suite = await suiteName(db, suiteId);
    if (suite === null) return { status: 'missing-suite' };
    const deleted = await db
      .delete(artifactBenchmarkAssignments)
      .where(
        and(
          eq(artifactBenchmarkAssignments.artifactId, artifactId),
          eq(artifactBenchmarkAssignments.suiteId, suiteId),
        ),
      )
      .returning({ suiteId: artifactBenchmarkAssignments.suiteId });
    return { status: deleted.length ? 'unassigned' : 'not-assigned', suiteName: suite };
  });
}

async function suiteName(db: Database, suiteId: string): Promise<string | null> {
  const suite = await db
    .select({ name: benchmarkSuites.name })
    .from(benchmarkSuites)
    .where(eq(benchmarkSuites.id, suiteId))
    .get();
  return suite?.name ?? null;
}

export interface LatestEvaluation {
  runId: string;
  verdict: string | null;
  status: string;
  delta: number | null;
  candidateOutcome: string | null;
  candidateScore: number | null;
  baselineScore: number | null;
  agentAdapterId: string;
  finishedAt: string | null;
  startedAt: string;
}

export interface ArtifactListItem {
  id: string;
  slug: string;
  name: string;
  type: ArtifactType;
  description: string | null;
  format: string | null;
  latestVersion: number | null;
  categories: { slug: string; name: string }[];
  /** Repositories with at least one active occurrence, ordered by name (FR-101-10). */
  repositories: { id: string; name: string }[];
  /** Active occurrences across all repositories (a path found in several places counts each). */
  occurrenceCount: number;
  benchmarkCount: number;
  latestEvaluation: LatestEvaluation | null;
}

/**
 * Filters of the artifacts list (SPEC-101 FR-101-11 subset). Every field is optional and they
 * combine with AND. Values are compared exactly, except `q`, a case-insensitive substring of the
 * name or description.
 */
export interface ArtifactListFilter {
  q?: string;
  type?: ArtifactType;
  /** A category slug: artifacts assigned to that category. */
  category?: string;
  /** A repository id: artifacts with an active occurrence in that repository. */
  repository?: string;
}

interface RunSummaryShape {
  candidateOutcome?: string | null;
  baseline?: { meanScore?: number | null };
  candidate?: { meanScore?: number | null };
  delta?: number | null;
}

function toLatestEvaluation(run: typeof benchmarkRuns.$inferSelect): LatestEvaluation {
  const summary = (run.summary ?? {}) as RunSummaryShape;
  return {
    runId: run.id,
    verdict: run.verdict,
    status: run.status,
    delta: summary.delta ?? null,
    candidateOutcome: summary.candidateOutcome ?? null,
    candidateScore: summary.candidate?.meanScore ?? null,
    baselineScore: summary.baseline?.meanScore ?? null,
    agentAdapterId: run.agentAdapterId,
    finishedAt: run.finishedAt,
    startedAt: run.startedAt,
  };
}

/**
 * Latest benchmark run per artifact (any version), keyed by artifact id. Callers pass a non-empty
 * `artifactIds` list.
 */
async function latestRunsByArtifact(
  db: Database,
  artifactIds: string[],
): Promise<Map<string, LatestEvaluation>> {
  const result = new Map<string, LatestEvaluation>();
  const rows = await db
    .select({ run: benchmarkRuns, artifactId: artifactVersions.artifactId })
    .from(benchmarkRuns)
    .innerJoin(artifactVersions, eq(benchmarkRuns.artifactVersionId, artifactVersions.id))
    .where(inArray(artifactVersions.artifactId, artifactIds))
    .orderBy(desc(benchmarkRuns.startedAt));
  for (const row of rows) {
    if (!result.has(row.artifactId)) result.set(row.artifactId, toLatestEvaluation(row.run));
  }
  return result;
}

function matchesText(row: { name: string; description: string | null }, q: string): boolean {
  return row.name.toLowerCase().includes(q) || (row.description ?? '').toLowerCase().includes(q);
}

export async function listArtifacts(
  db: Database,
  filter: ArtifactListFilter = {},
): Promise<ArtifactListItem[]> {
  const conditions = [];
  if (filter.type) conditions.push(eq(artifacts.type, filter.type));
  if (filter.category) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(artifactCategories)
          .innerJoin(categories, eq(artifactCategories.categoryId, categories.id))
          .where(
            and(
              eq(artifactCategories.artifactId, artifacts.id),
              eq(categories.slug, filter.category),
            ),
          ),
      ),
    );
  }
  if (filter.repository) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(artifactOccurrences)
          .where(
            and(
              eq(artifactOccurrences.artifactId, artifacts.id),
              eq(artifactOccurrences.repositoryId, filter.repository),
              eq(artifactOccurrences.status, 'active'),
            ),
          ),
      ),
    );
  }
  const q = filter.q?.trim().toLowerCase() ?? '';
  // Text search runs in JavaScript: SQLite's lower() folds ASCII only, `toLowerCase` folds all.
  const rows = (
    await db
      .select()
      .from(artifacts)
      .where(and(...conditions))
      .orderBy(artifacts.name, artifacts.id)
  ).filter((row) => !q || matchesText(row, q));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const versions = await db
    .select({
      artifactId: artifactVersions.artifactId,
      version: artifactVersions.version,
      format: artifactVersions.format,
    })
    .from(artifactVersions)
    .where(inArray(artifactVersions.artifactId, ids))
    .orderBy(desc(artifactVersions.version));
  const cats = await db
    .select({
      artifactId: artifactCategories.artifactId,
      slug: categories.slug,
      name: categories.name,
    })
    .from(artifactCategories)
    .innerJoin(categories, eq(artifactCategories.categoryId, categories.id))
    .where(inArray(artifactCategories.artifactId, ids))
    .orderBy(categories.name);
  const occurrences = await db
    .select({
      artifactId: artifactOccurrences.artifactId,
      repositoryId: repositories.id,
      name: repositories.name,
    })
    .from(artifactOccurrences)
    .innerJoin(repositories, eq(artifactOccurrences.repositoryId, repositories.id))
    .where(
      and(inArray(artifactOccurrences.artifactId, ids), eq(artifactOccurrences.status, 'active')),
    )
    .orderBy(repositories.name, repositories.id);
  const assignments = await db
    .select({ artifactId: artifactBenchmarkAssignments.artifactId })
    .from(artifactBenchmarkAssignments)
    .where(inArray(artifactBenchmarkAssignments.artifactId, ids));
  const latest = await latestRunsByArtifact(db, ids);

  // Grouped once, so building the rows is linear in the number of related rows (NFR-101-01).
  const byArtifact = <T extends { artifactId: string }>(items: T[]) => {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const group = groups.get(item.artifactId);
      if (group) group.push(item);
      else groups.set(item.artifactId, [item]);
    }
    return (id: string): T[] => groups.get(id) ?? [];
  };
  const versionsOf = byArtifact(versions);
  const categoriesOf = byArtifact(cats);
  const occurrencesOf = byArtifact(occurrences);
  const assignmentsOf = byArtifact(assignments);

  return rows.map((row) => {
    const latestVersion = versionsOf(row.id)[0];
    const found = occurrencesOf(row.id);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      type: row.type,
      description: row.description,
      format: latestVersion?.format ?? null,
      latestVersion: latestVersion?.version ?? null,
      categories: categoriesOf(row.id).map(({ slug, name }) => ({ slug, name })),
      repositories: [
        ...new Map(
          found.map((o) => [o.repositoryId, { id: o.repositoryId, name: o.name }]),
        ).values(),
      ],
      occurrenceCount: found.length,
      benchmarkCount: assignmentsOf(row.id).length,
      latestEvaluation: latest.get(row.id) ?? null,
    };
  });
}

/** Whether the registry holds any artifact (the list's empty state). */
export async function hasArtifacts(db: Database): Promise<boolean> {
  return (await db.select({ id: artifacts.id }).from(artifacts).limit(1).get()) !== undefined;
}

export async function getArtifactDetail(db: Database, artifactId: string) {
  const artifact = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
  if (!artifact) return null;
  const versions = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.version));
  const occurrences = await db
    .select({ occurrence: artifactOccurrences, repository: repositories })
    .from(artifactOccurrences)
    .innerJoin(repositories, eq(artifactOccurrences.repositoryId, repositories.id))
    .where(eq(artifactOccurrences.artifactId, artifactId))
    .orderBy(repositories.name, repositories.id, artifactOccurrences.path);
  const cats = await db
    .select({ slug: categories.slug, name: categories.name })
    .from(artifactCategories)
    .innerJoin(categories, eq(artifactCategories.categoryId, categories.id))
    .where(eq(artifactCategories.artifactId, artifactId))
    .orderBy(categories.name);
  const suites = await db
    .select({ id: benchmarkSuites.id, slug: benchmarkSuites.slug, name: benchmarkSuites.name })
    .from(artifactBenchmarkAssignments)
    .innerJoin(benchmarkSuites, eq(artifactBenchmarkAssignments.suiteId, benchmarkSuites.id))
    .where(eq(artifactBenchmarkAssignments.artifactId, artifactId));
  const versionIds = versions.map((v) => v.id);
  const runs =
    versionIds.length === 0
      ? []
      : await db
          .select({
            run: benchmarkRuns,
            artifactVersion: artifactVersions.version,
          })
          .from(benchmarkRuns)
          .innerJoin(artifactVersions, eq(benchmarkRuns.artifactVersionId, artifactVersions.id))
          .where(inArray(benchmarkRuns.artifactVersionId, versionIds))
          .orderBy(desc(benchmarkRuns.startedAt));
  return {
    artifact,
    versions,
    occurrences,
    categories: cats,
    suites,
    evaluations: runs.map((r) => ({
      ...toLatestEvaluation(r.run),
      artifactVersion: r.artifactVersion,
    })),
  };
}

export type ArtifactDetail = NonNullable<Awaited<ReturnType<typeof getArtifactDetail>>>;

/** Loads one exact artifact version in the shape agent adapters install. */
export async function getArtifactBundle(
  db: Database,
  versionId: string,
): Promise<ArtifactBundle | null> {
  const row = await db
    .select({ version: artifactVersions, artifact: artifacts })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifactVersions.artifactId, artifacts.id))
    .where(eq(artifactVersions.id, versionId))
    .get();
  if (!row) return null;
  return {
    artifactId: row.artifact.id,
    versionId: row.version.id,
    slug: row.artifact.slug,
    name: row.artifact.name,
    type: row.artifact.type,
    format: row.version.format as ArtifactFormat,
    contentHash: row.version.contentHash,
    files: row.version.files,
  };
}

export async function getLatestArtifactVersionId(
  db: Database,
  artifactId: string,
): Promise<string | null> {
  const row = await db
    .select({ id: artifactVersions.id })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.version))
    .limit(1)
    .get();
  return row?.id ?? null;
}

/** Closest artifacts (or newest versions) named when a reference matches none (FR-118-22). */
export const ARTIFACT_REF_SUGGESTIONS = 5;

export type ArtifactRefErrorCode = 'artifact-not-found' | 'version-not-found';

/** A `--artifact <ref>` (and `--version <n>`) that names nothing (SPEC-118 FR-118-22). */
export class ArtifactRefError extends Error {
  override name = 'ArtifactRefError';
  constructor(
    readonly code: ArtifactRefErrorCode,
    message: string,
    /** Closest artifact slugs, or the artifact's version numbers (newest first). */
    readonly candidates: string[],
  ) {
    super(message);
  }
}

export interface ResolvedArtifactRef {
  artifact: { id: string; slug: string; name: string; type: ArtifactType };
  version: { id: string; version: number; format: string; contentHash: string };
  /** How many versions the artifact has; `--baseline vN` needs at least two. */
  versionCount: number;
}

/** `%` and `_` are LIKE wildcards; `\` escapes them (and itself). */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Resolves an artifact reference for the CLI (SPEC-118 FR-118-22): an artifact id, else a slug
 * (both are unique, and the id wins when one artifact's id is another's slug). `version` selects a
 * version number; without it the latest version is chosen. Throws {@link ArtifactRefError} with
 * the closest slugs (substring of slug or name) or the newest version numbers, at most
 * {@link ARTIFACT_REF_SUGGESTIONS} each.
 */
export async function resolveArtifactRef(
  db: Database,
  ref: string,
  version?: number,
): Promise<ResolvedArtifactRef> {
  const columns = {
    id: artifacts.id,
    slug: artifacts.slug,
    name: artifacts.name,
    type: artifacts.type,
  };
  const artifact =
    (await db.select(columns).from(artifacts).where(eq(artifacts.id, ref)).get()) ??
    (await db.select(columns).from(artifacts).where(eq(artifacts.slug, ref)).get());
  if (!artifact) {
    const pattern = likePattern(ref.toLowerCase());
    const close = await db
      .select({ slug: artifacts.slug })
      .from(artifacts)
      .where(
        or(
          sql`lower(${artifacts.slug}) like ${pattern} escape '\\'`,
          sql`lower(${artifacts.name}) like ${pattern} escape '\\'`,
        ),
      )
      .orderBy(artifacts.slug)
      .limit(ARTIFACT_REF_SUGGESTIONS);
    throw new ArtifactRefError(
      'artifact-not-found',
      `No artifact has the id or slug "${ref}".`,
      close.map((row) => row.slug),
    );
  }
  const versions = await db
    .select({
      id: artifactVersions.id,
      version: artifactVersions.version,
      format: artifactVersions.format,
      contentHash: artifactVersions.contentHash,
    })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifact.id))
    .orderBy(desc(artifactVersions.version));
  const chosen =
    version === undefined ? versions[0] : versions.find((row) => row.version === version);
  if (!chosen) {
    throw new ArtifactRefError(
      'version-not-found',
      version === undefined
        ? `Artifact "${artifact.slug}" has no versions.`
        : `Artifact "${artifact.slug}" has no version ${version}.`,
      versions.slice(0, ARTIFACT_REF_SUGGESTIONS).map((row) => `v${row.version}`),
    );
  }
  return { artifact, version: chosen, versionCount: versions.length };
}
