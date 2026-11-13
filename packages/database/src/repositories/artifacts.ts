import {
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  max,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { ArtifactBundle, ArtifactFormat, ArtifactType } from '@directivebench/core';
import {
  classifyArtifactPath,
  createId,
  hashManifest,
  idListFingerprint,
  nowIso,
  parseArtifactFile,
  parseFrontmatter,
  sha256,
  slugify,
  unseenOccurrencePaths,
} from '@directivebench/core';
import { alias } from 'drizzle-orm/sqlite-core';
import { withTransaction, type Database, type DatabaseHandle } from '../client';
import type { CategoryRef } from './catalog';
import { JobNoLongerRunningError, LOCAL_PROVIDERS, NotFoundError } from './jobs';
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

/** Where a version write happens: the repository and the commit read (null for a working tree). */
interface WriteTarget {
  repositoryId: string;
  commitSha: string | null;
}

/** The occurrence row at the written path, read before the write. */
interface OccurrenceRow {
  id: string;
  artifactId: string;
  status: 'active' | 'removed';
  latestVersionId: string;
}

/** Rule 4: a new artifact with the first free slug of `slugBase` (SPEC-105 FR-105-16 c). */
async function insertArtifact(
  db: Database,
  allocateSlug: SlugAllocator,
  slugBase: string,
  input: Pick<VersionContent, 'name' | 'type' | 'description'>,
): Promise<{ id: string; createdAt: string }> {
  const now = nowIso();
  const id = createId('art');
  await db.insert(artifacts).values({
    id,
    slug: await allocateSlug(slugBase),
    name: input.name,
    type: input.type,
    description: input.description,
    createdAt: now,
    updatedAt: now,
  });
  return { id, createdAt: now };
}

/**
 * Writes one observed artifact version inside the caller's transaction, for an artifact the
 * caller already identified: adds an immutable version only when the content hash is new for that
 * artifact, and points the occurrence at it (inserted, or the given row updated). A new version
 * records the version the occurrence held before when it belongs to the same artifact (SPEC-126
 * FR-126-19); it is never updated later. User-managed metadata (notes, tags, categories, benchmark
 * assignments) is never touched.
 */
async function writeVersionAndOccurrence(
  db: Database,
  target: WriteTarget,
  artifactId: string,
  occurrence: OccurrenceRow | undefined,
  input: VersionContent,
  recomputed: { files: StoredArtifactFile[]; contentHash: string },
): Promise<ImportArtifactResult & { reactivatedOccurrence: boolean }> {
  const now = nowIso();
  const { repositoryId, commitSha } = target;
  const { files, contentHash } = recomputed;

  let version = await db
    .select({ id: artifactVersions.id, version: artifactVersions.version })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.artifactId, artifactId),
        eq(artifactVersions.contentHash, contentHash),
      ),
    )
    .get();
  let createdVersion = false;
  if (!version) {
    const current = await db
      .select({ value: max(artifactVersions.version) })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifactId))
      .get();
    version = { id: createId('artv'), version: (current?.value ?? 0) + 1 };
    await db.insert(artifactVersions).values({
      id: version.id,
      artifactId,
      version: version.version,
      contentHash,
      format: input.format,
      primaryFile: input.primaryFile,
      files,
      parsedMetadata: input.parsedMetadata,
      sourceRepositoryId: repositoryId,
      sourcePath: input.path,
      sourceCommitSha: commitSha,
      parentVersionId: occurrence?.artifactId === artifactId ? occurrence.latestVersionId : null,
      createdAt: now,
    });
    createdVersion = true;
  }

  if (occurrence) {
    await db
      .update(artifactOccurrences)
      .set({
        artifactId,
        latestVersionId: version.id,
        commitSha,
        status: 'active',
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(artifactOccurrences.id, occurrence.id));
  } else {
    await insertOccurrence(db, target, artifactId, input.path, version.id);
  }

  return {
    artifactId,
    versionId: version.id,
    version: version.version,
    createdVersion,
    // A missing occurrence found again (SPEC-125 FR-125-05): same occurrence, same artifact.
    reactivatedOccurrence: occurrence?.status === 'removed',
  };
}

async function insertOccurrence(
  db: Database,
  { repositoryId, commitSha }: WriteTarget,
  artifactId: string,
  path: string,
  versionId: string,
): Promise<void> {
  const now = nowIso();
  await db.insert(artifactOccurrences).values({
    id: createId('occ'),
    artifactId,
    repositoryId,
    path,
    latestVersionId: versionId,
    commitSha,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Records an artifact found in a source (bundled examples). Its identity is the bootstrap rule
 * for bundled examples, whose location changes between installs (SPEC-101 §8.3): an artifact that
 * already occurs in a repository of the same provider and has the same slug (or, when its slug got
 * a suffix, the same name and type); otherwise a new artifact with the first free slug (rule 4).
 * Rule 3 never applies here (SPEC-126 FR-126-05), so a scanned skill never attaches to the bundled
 * demo skill and vice versa. Adds an immutable version only when the content hash is new, points
 * the occurrence at it, and sets the source fields (name, description) from this write. Hashes are
 * recomputed from the content (see `recomputeFiles`). User-managed metadata is never touched.
 */
export async function importArtifactVersion(
  handle: DatabaseHandle,
  input: ImportArtifactInput,
): Promise<ImportArtifactResult> {
  const recomputed = recomputeFiles(input);
  return withTransaction(handle, async (db) => {
    const repositoryId = await upsertRepository(db, input.repository);
    const found = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .innerJoin(artifactOccurrences, eq(artifactOccurrences.artifactId, artifacts.id))
      .innerJoin(repositories, eq(artifactOccurrences.repositoryId, repositories.id))
      .where(
        and(
          eq(repositories.provider, input.repository.provider),
          // The slug, or — when that slug was taken and the artifact got a suffix — name and type.
          or(
            eq(artifacts.slug, input.slug),
            and(eq(artifacts.name, input.name), eq(artifacts.type, input.type)),
          ),
        ),
      )
      .orderBy(artifacts.createdAt, artifacts.id)
      .get();
    let artifactId: string;
    if (found) {
      artifactId = found.id;
      // Source-derived fields follow the source; user-managed fields are left untouched.
      await db
        .update(artifacts)
        .set({ name: input.name, description: input.description, updatedAt: nowIso() })
        .where(eq(artifacts.id, artifactId));
    } else {
      artifactId = (await insertArtifact(db, slugAllocator(db), input.slug, input)).id;
    }
    const occurrence = await db
      .select({
        id: artifactOccurrences.id,
        artifactId: artifactOccurrences.artifactId,
        status: artifactOccurrences.status,
        latestVersionId: artifactOccurrences.latestVersionId,
      })
      .from(artifactOccurrences)
      .where(
        and(
          eq(artifactOccurrences.repositoryId, repositoryId),
          eq(artifactOccurrences.path, input.path),
        ),
      )
      .get();
    const { reactivatedOccurrence: _reactivated, ...result } = await writeVersionAndOccurrence(
      db,
      { repositoryId, commitSha: input.commitSha ?? null },
      artifactId,
      occurrence,
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
  /** Rule-4 artifacts this scan created; occurrences linked to an existing artifact are not counted. */
  createdArtifacts: number;
  createdVersions: number;
  /** Active occurrences this scan did not find and marked `removed` (SPEC-125 FR-125-06). */
  removedOccurrences: number;
  /** `removed` occurrences this scan found again and made `active` (FR-125-05). */
  reactivatedOccurrences: number;
  /** Active occurrences kept by the empty-scan guard (A7, FR-125-04); 0 otherwise. */
  emptyScanKeptOccurrences: number;
  /** New paths added to an existing artifact by rule 3, ambiguous ones included (SPEC-126 FR-126-09). */
  linkedOccurrences: number;
  /** Rule-3 links that had several candidate artifacts and took the oldest (FR-126-03, A7). */
  ambiguousLinks: number;
}

/** Most occurrence ids marked `removed` by one statement: well under SQLite's parameter limit. */
export const REMOVED_OCCURRENCE_BATCH_SIZE = 500;

/**
 * Most content hashes or artifact ids per identity read inside a scan transaction (SPEC-126
 * NFR-126-01): the rule-3 candidate read and the source-field refresh read in batches of this size.
 */
export const IDENTITY_LOOKUP_BATCH_SIZE = 500;

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
  /**
   * Repository-relative paths the scan could not observe (`DiscoveryResult.unobserved`, SPEC-125
   * FR-125-03), from the full discovery result. Occurrences equal to, inside or containing one
   * are never marked `removed`. Required, so a caller that forgets it does not compile.
   */
  unobserved: readonly string[];
}

/** Providers whose occurrences may link and be linked to by rule 3 (SPEC-126 A16). */
const LINKING_PROVIDERS: readonly RepositoryProvider[] = LOCAL_PROVIDERS;

/** Single-file formats named after their file, so the name is part of the hashed manifest (A2). */
const FILE_NAMED_FORMATS: ReadonlySet<string> = new Set<ArtifactFormat>([
  'cursor-rule',
  'claude-rule',
  'copilot-path-instructions',
]);

/**
 * Whether rule 3 may link this content (SPEC-126 A2, A3, FR-126-06): a rule format named after its
 * file, or a skill whose `SKILL.md` has a frontmatter `name` (read from the stored content, never
 * from caller metadata). Equal content hashes therefore imply equal names. Instructions, GitLab Duo
 * chat rules and skills named only by their directory are identified by location only.
 */
function isLinkable(
  input: Pick<VersionContent, 'format' | 'primaryFile'>,
  files: readonly StoredArtifactFile[],
): boolean {
  if (FILE_NAMED_FORMATS.has(input.format)) return true;
  if (input.format !== 'skill-md') return false;
  const primary = files.find((file) => file.path === input.primaryFile);
  const name: unknown = primary ? parseFrontmatter(primary.content).frontmatter.name : undefined;
  return typeof name === 'string' && name.trim() !== '';
}

/** The rule-3 key: equal content hash and equal format (A2). */
function linkKey(contentHash: string, format: string): string {
  return `${contentHash}\u0000${format}`;
}

/** A version an exact copy can be linked to, with its artifact's age for the A7 choice. */
interface LinkCandidate {
  artifactId: string;
  versionId: string;
  artifactCreatedAt: string;
}

/** Code-unit order (SPEC-126 FR-126-24), independent of the locale. */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Oldest artifact first (`created_at`, then id), the A7 choice among several candidates. */
function compareCandidates(a: LinkCandidate, b: LinkCandidate): number {
  return (
    compareCodeUnits(a.artifactCreatedAt, b.artifactCreatedAt) ||
    compareCodeUnits(a.artifactId, b.artifactId)
  );
}

/**
 * Reads the rule-3 candidates for the given keys in batches of `IDENTITY_LOOKUP_BATCH_SIZE` hashes
 * (NFR-126-01): versions with an equal content hash and format whose artifact has at least one
 * occurrence (any status, A4) and no occurrence outside local repositories (A16; bundled examples
 * included, A5). Both conditions use the occurrences' artifact index, so each batch is one
 * statement. Candidates per key are sorted oldest artifact first.
 */
async function readLinkCandidates(
  db: Database,
  keys: ReadonlyMap<string, { contentHash: string; format: string }>,
): Promise<Map<string, LinkCandidate[]>> {
  const hashes = [...new Set([...keys.values()].map(({ contentHash }) => contentHash))];
  const candidates = new Map<string, LinkCandidate[]>();
  const nonLocal = db
    .select({ one: sql`1` })
    .from(artifactOccurrences)
    .innerJoin(repositories, eq(artifactOccurrences.repositoryId, repositories.id))
    .where(
      and(
        eq(artifactOccurrences.artifactId, artifactVersions.artifactId),
        notInArray(repositories.provider, [...LINKING_PROVIDERS]),
      ),
    );
  const anyOccurrence = db
    .select({ one: sql`1` })
    .from(artifactOccurrences)
    .where(eq(artifactOccurrences.artifactId, artifactVersions.artifactId));
  for (let start = 0; start < hashes.length; start += IDENTITY_LOOKUP_BATCH_SIZE) {
    const rows = await db
      .select({
        artifactId: artifactVersions.artifactId,
        versionId: artifactVersions.id,
        contentHash: artifactVersions.contentHash,
        format: artifactVersions.format,
        artifactCreatedAt: artifacts.createdAt,
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(
        and(
          inArray(
            artifactVersions.contentHash,
            hashes.slice(start, start + IDENTITY_LOOKUP_BATCH_SIZE),
          ),
          exists(anyOccurrence),
          notExists(nonLocal),
        ),
      );
    for (const { contentHash, format, ...candidate } of rows) {
      const key = linkKey(contentHash, format);
      if (!keys.has(key)) continue;
      const list = candidates.get(key);
      if (list) list.push(candidate);
      else candidates.set(key, [candidate]);
    }
  }
  for (const list of candidates.values()) list.sort(compareCandidates);
  return candidates;
}

/** One discovered artifact of a scan with its recomputed files and content hash. */
interface PreparedArtifact {
  input: ScannedArtifactInput;
  recomputed: { files: StoredArtifactFile[]; contentHash: string };
}

/**
 * Stores the artifacts a scan of a registered repository discovered, in one transaction
 * (SPEC-105 FR-105-09 subset): hashes are recomputed from content and versions dedup by content
 * hash within their artifact, and the repository records a successful scan (`last_sync_at`,
 * `sync_status = 'ok'`, `sync_error = null`) with the commit read (`last_commit_sha`; null for a
 * working-tree scan, which reads no commit).
 *
 * Identity (SPEC-101 §8.3, SPEC-126 FR-126-01, FR-126-24) is resolved in an order independent of
 * the discovery order: first every path with an occurrence row of this repository (rule 1: same
 * artifact, a `removed` row becomes `active` again, FR-125-05), then the new paths in ascending
 * code-unit order. A new path of a linkable format (`isLinkable`) in a local repository is added
 * to the oldest existing artifact that has a version with the same content hash and format and
 * occurs only in local repositories (rule 3, A7: counted in `ambiguousLinks` when there were
 * several), pointing at that version without creating one; otherwise it becomes a new artifact
 * with the first free slug (rule 4). The candidate map is read in batches after the rule-1 writes
 * and updated with this scan's own new artifacts, so identical new paths of one scan share one
 * artifact (FR-126-04).
 *
 * The scan observed the whole snapshot (every failure path returns before this call), so in the
 * same transaction every other active occurrence of this repository that it did not find is marked
 * `removed`, shown as missing (SPEC-125 FR-125-04): `status` and `updated_at` change, its version,
 * commit and `last_seen_at` stay. Occurrences covered by an `unobserved` path are kept
 * (FR-125-03), and a scan that found no artifact at all marks nothing (the empty-scan guard, A7):
 * its result counts the active occurrences it kept. Nothing is deleted. Last, the name and
 * description of every artifact the scan wrote, linked or marked follow its active occurrences
 * (`refreshSourceFields`, FR-126-07).
 *
 * The job is re-checked inside the transaction: a scan whose signal was aborted, or that was
 * cancelled or interrupted meanwhile, writes nothing (a `JobNoLongerRunningError`, FR-105-17), and
 * a repository removed meanwhile is a `NotFoundError`. A failure while one artifact is written
 * rolls everything back and is an `ArtifactStoreError` carrying the path where it happened.
 */
export async function applyRepositoryScan(
  handle: DatabaseHandle,
  application: RepositoryScanApplication,
): Promise<RepositoryScanSummary> {
  const { repositoryId, jobId } = application;
  const prepared: PreparedArtifact[] = application.artifacts
    .map((input) => ({ input, recomputed: recomputeFiles(input) }))
    .sort((a, b) => compareCodeUnits(a.input.path, b.input.path));
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
    const summary: RepositoryScanSummary = {
      createdArtifacts: 0,
      createdVersions: 0,
      removedOccurrences: 0,
      reactivatedOccurrences: 0,
      emptyScanKeptOccurrences: 0,
      linkedOccurrences: 0,
      ambiguousLinks: 0,
    };
    const target: WriteTarget = { repositoryId, commitSha: application.commitSha };
    /** Artifacts whose source fields are refreshed at the end (FR-126-07). */
    const touched = new Set<string>();
    const write = async (path: string, step: () => Promise<void>) => {
      await step().catch((error: unknown) => {
        throw new ArtifactStoreError(path, { cause: error });
      });
    };

    // Rule 1: every path this repository already has an occurrence row for, active or removed.
    const rows = await db
      .select({
        id: artifactOccurrences.id,
        path: artifactOccurrences.path,
        artifactId: artifactOccurrences.artifactId,
        status: artifactOccurrences.status,
        latestVersionId: artifactOccurrences.latestVersionId,
      })
      .from(artifactOccurrences)
      .where(eq(artifactOccurrences.repositoryId, repositoryId));
    const rowByPath = new Map(rows.map((row) => [row.path, row]));
    const added: PreparedArtifact[] = [];
    for (const item of prepared) {
      const occurrence = rowByPath.get(item.input.path);
      if (!occurrence) {
        added.push(item);
        continue;
      }
      await write(item.input.path, async () => {
        const result = await writeVersionAndOccurrence(
          db,
          target,
          occurrence.artifactId,
          occurrence,
          item.input,
          item.recomputed,
        );
        touched.add(occurrence.artifactId);
        summary.createdVersions += Number(result.createdVersion);
        summary.reactivatedOccurrences += Number(result.reactivatedOccurrence);
      });
    }

    // Rules 3 and 4 for the new paths, in path order.
    const linking = LINKING_PROVIDERS.includes(repository.provider);
    const linkable = new Map<string, { contentHash: string; format: string }>();
    if (linking) {
      for (const { input, recomputed } of added) {
        if (isLinkable(input, recomputed.files)) {
          linkable.set(linkKey(recomputed.contentHash, input.format), {
            contentHash: recomputed.contentHash,
            format: input.format,
          });
        }
      }
    }
    const candidates = await readLinkCandidates(db, linkable);
    const allocateSlug = slugAllocator(db);
    for (const { input, recomputed } of added) {
      const key = linkKey(recomputed.contentHash, input.format);
      const [chosen, ...others] = linkable.has(key) ? (candidates.get(key) ?? []) : [];
      await write(input.path, async () => {
        if (chosen) {
          await insertOccurrence(db, target, chosen.artifactId, input.path, chosen.versionId);
          touched.add(chosen.artifactId);
          summary.linkedOccurrences += 1;
          summary.ambiguousLinks += Number(others.length > 0);
          return;
        }
        const artifact = await insertArtifact(db, allocateSlug, slugify(input.name), input);
        const result = await writeVersionAndOccurrence(
          db,
          target,
          artifact.id,
          undefined,
          input,
          recomputed,
        );
        touched.add(artifact.id);
        summary.createdArtifacts += 1;
        summary.createdVersions += Number(result.createdVersion);
        if (linkable.has(key)) {
          candidates.set(key, [
            {
              artifactId: artifact.id,
              versionId: result.versionId,
              artifactCreatedAt: artifact.createdAt,
            },
          ]);
        }
      });
    }

    for (const artifactId of await markUnseenOccurrences(db, application, summary)) {
      touched.add(artifactId);
    }
    await refreshSourceFields(db, [...touched]);
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
 * The marking step of {@link applyRepositoryScan} (SPEC-125 FR-125-04), inside its transaction,
 * after the scan's own writes: with no artifact discovered it only counts the active occurrences
 * it keeps (A7); otherwise it marks the unseen ones `removed`, in batches by id. Returns the
 * artifacts of the occurrences it marked.
 */
async function markUnseenOccurrences(
  db: Database,
  application: RepositoryScanApplication,
  summary: RepositoryScanSummary,
): Promise<string[]> {
  const { repositoryId } = application;
  const active = await db
    .select({
      id: artifactOccurrences.id,
      path: artifactOccurrences.path,
      artifactId: artifactOccurrences.artifactId,
    })
    .from(artifactOccurrences)
    .where(
      and(
        eq(artifactOccurrences.repositoryId, repositoryId),
        eq(artifactOccurrences.status, 'active'),
      ),
    );
  if (application.artifacts.length === 0) {
    summary.emptyScanKeptOccurrences = active.length;
    return [];
  }
  const unseen = new Set(
    unseenOccurrencePaths({
      active: active.map((occurrence) => occurrence.path),
      discovered: application.artifacts.map((artifact) => artifact.path),
      unobserved: application.unobserved,
    }),
  );
  const marked = active.filter((occurrence) => unseen.has(occurrence.path));
  const ids = marked.map(({ id }) => id);
  const now = nowIso();
  for (let start = 0; start < ids.length; start += REMOVED_OCCURRENCE_BATCH_SIZE) {
    await db
      .update(artifactOccurrences)
      .set({ status: 'removed', updatedAt: now })
      .where(
        and(
          eq(artifactOccurrences.repositoryId, repositoryId),
          eq(artifactOccurrences.status, 'active'),
          inArray(artifactOccurrences.id, ids.slice(start, start + REMOVED_OCCURRENCE_BATCH_SIZE)),
        ),
      );
  }
  summary.removedOccurrences = ids.length;
  return marked.map(({ artifactId }) => artifactId);
}

/** Where discovery reads an occurrence's primary file, relative to the repository root. */
function primaryPathOf(format: string, occurrencePath: string): string {
  if (format !== 'skill-md') return occurrencePath;
  return occurrencePath === '' ? 'SKILL.md' : `${occurrencePath}/SKILL.md`;
}

/**
 * Sets each artifact's name and description from its active occurrences (SPEC-126 FR-126-07, A9),
 * inside the caller's transaction: the active occurrence holding the highest version number (ties:
 * oldest occurrence `created_at`, then id) names it, parsed with core's `parseArtifactFile` from
 * that version's primary file at the path discovery would read. Only changed fields are written;
 * an artifact with no active occurrence keeps them, and so does one whose chosen version lacks its
 * primary file or whose occurrence path does not classify as the version's format (rows
 * DirectiveBench's scans never write: kept rather than guessed). The result depends only on the
 * active occurrences and their version numbers, never on which scan ran last. Two reads per
 * `IDENTITY_LOOKUP_BATCH_SIZE` artifacts: the occurrences with their versions' numbers, then the
 * chosen versions' files. `slug` never changes (FR-105-13).
 */
export async function refreshSourceFields(
  db: Database,
  artifactIds: readonly string[],
): Promise<void> {
  for (let start = 0; start < artifactIds.length; start += IDENTITY_LOOKUP_BATCH_SIZE) {
    const rows = await db
      .select({
        occurrenceId: artifactOccurrences.id,
        occurrenceCreatedAt: artifactOccurrences.createdAt,
        artifactId: artifactOccurrences.artifactId,
        path: artifactOccurrences.path,
        versionId: artifactVersions.id,
        version: artifactVersions.version,
        format: artifactVersions.format,
        name: artifacts.name,
        description: artifacts.description,
      })
      .from(artifactOccurrences)
      .innerJoin(artifactVersions, eq(artifactVersions.id, artifactOccurrences.latestVersionId))
      .innerJoin(artifacts, eq(artifacts.id, artifactOccurrences.artifactId))
      .where(
        and(
          inArray(
            artifactOccurrences.artifactId,
            artifactIds.slice(start, start + IDENTITY_LOOKUP_BATCH_SIZE),
          ),
          eq(artifactOccurrences.status, 'active'),
        ),
      );
    const chosen = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const best = chosen.get(row.artifactId);
      if (
        !best ||
        row.version > best.version ||
        (row.version === best.version &&
          (compareCodeUnits(row.occurrenceCreatedAt, best.occurrenceCreatedAt) ||
            compareCodeUnits(row.occurrenceId, best.occurrenceId)) < 0)
      ) {
        chosen.set(row.artifactId, row);
      }
    }
    if (chosen.size === 0) continue;
    const contents = await db
      .select({
        id: artifactVersions.id,
        primaryFile: artifactVersions.primaryFile,
        files: artifactVersions.files,
      })
      .from(artifactVersions)
      .where(
        inArray(
          artifactVersions.id,
          [...chosen.values()].map(({ versionId }) => versionId),
        ),
      );
    const primaryContent = new Map(
      contents.map(({ id, primaryFile, files }) => [
        id,
        files.find((file) => file.path === primaryFile)?.content,
      ]),
    );
    for (const row of chosen.values()) {
      const content = primaryContent.get(row.versionId);
      const primaryPath = primaryPathOf(row.format, row.path);
      // Only a path discovery would have read as this format can be parsed as it.
      if (content === undefined || classifyArtifactPath(primaryPath)?.format !== row.format) {
        continue;
      }
      const parsed = parseArtifactFile(primaryPath, content);
      if (parsed.name === row.name && parsed.description === row.description) continue;
      await db
        .update(artifacts)
        .set({ name: parsed.name, description: parsed.description, updatedAt: nowIso() })
        .where(eq(artifacts.id, row.artifactId));
    }
  }
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

/**
 * Assigns the active category `which` selects to an artifact in one conditional statement
 * (`INSERT … SELECT … WHERE archived_at IS NULL … ON CONFLICT DO NOTHING`), so an archive committed
 * by another process cannot slip between a check and the write (SPEC-014, SPEC-124 FR-124-11).
 * Returns whether a row was inserted; nothing is inserted for an archived or unknown category, a
 * missing artifact, or an existing assignment.
 */
async function insertActiveAssignment(
  db: Database,
  artifactId: string,
  which: SQL,
): Promise<boolean> {
  const inserted = await db
    .insert(artifactCategories)
    .select(
      db
        .select({
          artifactId: sql<string>`${artifactId}`.as('artifact_id'),
          categoryId: categories.id,
          createdAt: sql<string>`${nowIso()}`.as('created_at'),
        })
        .from(categories)
        .where(
          and(
            which,
            isNull(categories.archivedAt),
            exists(
              db
                .select({ one: sql`1` })
                .from(artifacts)
                .where(eq(artifacts.id, artifactId)),
            ),
          ),
        ),
    )
    .onConflictDoNothing()
    .returning({ artifactId: artifactCategories.artifactId });
  return inserted.length > 0;
}

/**
 * Assigns existing, non-archived categories by slug (the example import, FR-106-06). Unknown and
 * archived slugs are returned as `unknown`, never created; `assigned` lists the slugs whose active
 * category the artifact now has, newly or already. Each slug is one conditional statement, so a
 * category archived concurrently is never newly assigned (SPEC-124 §8.2).
 */
export async function assignCategoriesBySlug(
  db: Database,
  artifactId: string,
  slugs: readonly string[],
): Promise<{ assigned: string[]; unknown: string[] }> {
  const assigned: string[] = [];
  for (const slug of new Set(slugs)) {
    const inserted = await insertActiveAssignment(db, artifactId, eq(categories.slug, slug));
    // A no-op insert is still "assigned" when the artifact already has the active category.
    if (inserted || (await hasActiveCategory(db, artifactId, slug))) assigned.push(slug);
  }
  return { assigned, unknown: slugs.filter((slug) => !assigned.includes(slug)) };
}

async function hasActiveCategory(db: Database, artifactId: string, slug: string) {
  const row = await db
    .select({ one: sql`1` })
    .from(artifactCategories)
    .innerJoin(categories, eq(artifactCategories.categoryId, categories.id))
    .where(
      and(
        eq(artifactCategories.artifactId, artifactId),
        eq(categories.slug, slug),
        isNull(categories.archivedAt),
      ),
    )
    .get();
  return row !== undefined;
}

/** The category as it is now, read after an assignment write (SPEC-124 §8.2). */
async function readCategoryRef(db: Database, categoryId: string): Promise<CategoryRef | undefined> {
  const row = await db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      archivedAt: categories.archivedAt,
    })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .get();
  return row && { id: row.id, slug: row.slug, name: row.name, archived: row.archivedAt !== null };
}

async function artifactExists(db: Database, artifactId: string): Promise<boolean> {
  const row = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .get();
  return row !== undefined;
}

export type AssignArtifactCategoryOutcome =
  | { status: 'assigned' | 'already-assigned' | 'category-archived'; category: CategoryRef }
  | { status: 'category-not-found' | 'artifact-not-found' };

/**
 * Assigns an active category to an artifact; idempotent (SPEC-124 FR-124-11). The write is one
 * conditional statement; the follow-up reads only explain a no-op insert. An archived category is
 * refused, also when the artifact already has it. The category is read after the write, so the
 * outcome names it as it is now (a rename in another tab shows the new name). The insert and the
 * reads run in one `withTransaction`, so no archive or unarchive lands between them and a no-op
 * is explained by the state the insert saw (Codex review on PR 198).
 */
export async function assignArtifactCategory(
  handle: DatabaseHandle,
  artifactId: string,
  categoryId: string,
): Promise<AssignArtifactCategoryOutcome> {
  return withTransaction(handle, async (db) => {
    const inserted = await insertActiveAssignment(db, artifactId, eq(categories.id, categoryId));
    const category = await readCategoryRef(db, categoryId);
    if (!category) return { status: 'category-not-found' };
    if (inserted) return { status: 'assigned', category };
    if (!(await artifactExists(db, artifactId))) return { status: 'artifact-not-found' };
    return { status: category.archived ? 'category-archived' : 'already-assigned', category };
  });
}

export type UnassignArtifactCategoryOutcome =
  | { status: 'removed' | 'not-assigned'; category: CategoryRef }
  | { status: 'category-not-found' | 'artifact-not-found' };

/**
 * Removes a category from an artifact; idempotent and allowed for archived categories
 * (SPEC-124 FR-124-12). One `DELETE … RETURNING`; the follow-up reads only explain a no-op. The
 * category is read after the write, as for `assignArtifactCategory`.
 */
export async function unassignArtifactCategory(
  db: Database,
  artifactId: string,
  categoryId: string,
): Promise<UnassignArtifactCategoryOutcome> {
  const removed = await db
    .delete(artifactCategories)
    .where(
      and(
        eq(artifactCategories.artifactId, artifactId),
        eq(artifactCategories.categoryId, categoryId),
      ),
    )
    .returning({ artifactId: artifactCategories.artifactId });
  const category = await readCategoryRef(db, categoryId);
  if (!category) return { status: 'category-not-found' };
  if (removed.length > 0) return { status: 'removed', category };
  if (!(await artifactExists(db, artifactId))) return { status: 'artifact-not-found' };
  return { status: 'not-assigned', category };
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
    const artifact = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .get();
    if (!artifact) return { status: 'missing-artifact' };
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

/** A category assigned to an artifact; archived ones stay assigned (SPEC-124 A8). */
export interface ArtifactCategory {
  id: string;
  slug: string;
  name: string;
  archived: boolean;
}

function toArtifactCategory(row: {
  id: string;
  slug: string;
  name: string;
  archivedAt: string | null;
}): ArtifactCategory {
  return { id: row.id, slug: row.slug, name: row.name, archived: row.archivedAt !== null };
}

/** Orders assigned categories: active first, then by name. */
const assignedCategoryOrder = [sql`${categories.archivedAt} is not null`, categories.name];

export interface ArtifactListItem {
  id: string;
  slug: string;
  name: string;
  type: ArtifactType;
  description: string | null;
  format: string | null;
  latestVersion: number | null;
  /** Active categories first, then archived ones, each by name (SPEC-124 §8.2). */
  categories: ArtifactCategory[];
  /** Repositories with at least one active occurrence, ordered by name (FR-101-10). */
  repositories: { id: string; name: string }[];
  /** Active occurrences across all repositories (a path found in several places counts each). */
  occurrenceCount: number;
  /** No active occurrence anywhere (SPEC-125 FR-125-08, A8): shown as missing. */
  missing: boolean;
  benchmarkCount: number;
  latestEvaluation: LatestEvaluation | null;
  /**
   * Other artifacts whose latest version has the same format and exactly the same name, for a
   * format of `POSSIBLE_DUPLICATE_FORMATS` (SPEC-126 FR-126-11, FR-126-12); 0 otherwise.
   */
  possibleDuplicates: number;
}

/**
 * Formats whose same-named artifacts are possible duplicates (SPEC-126 FR-126-11, A3, §11.4 G14):
 * the formats rule 3 can link. The format alone decides, so a skill without a frontmatter `name`
 * (named after its directory) is flagged too, and nothing is parsed on read.
 */
export const POSSIBLE_DUPLICATE_FORMATS: readonly ArtifactFormat[] = [
  'skill-md',
  'cursor-rule',
  'claude-rule',
  'copilot-path-instructions',
];

/** At most this many possible duplicates are listed on an artifact page (SPEC-126 FR-126-13). */
export const MAX_LISTED_DUPLICATES = 20;

/** Another artifact with the same name and format (SPEC-126 FR-126-13, §8.3). */
export interface PossibleDuplicate {
  id: string;
  slug: string;
  name: string;
  /** Active occurrences across all repositories; 0 when it is missing (§11.4 G13). */
  activeOccurrences: number;
  /** Repositories with at least one active occurrence, ordered by name (§11.4 G8, FR-101-10). */
  repositories: { id: string; name: string }[];
  /** Its latest version's `content_hash` equals this artifact's latest one. */
  sameLatestContent: boolean;
}

/** Each artifact's latest version, joined as `latest` (the highest number, SPEC-101 §8.2). */
const latestVersionRow = alias(artifactVersions, 'latest');
const isLatestVersion = and(
  eq(latestVersionRow.artifactId, artifacts.id),
  eq(
    latestVersionRow.version,
    sql`(select max(${artifactVersions.version}) from ${artifactVersions} where ${artifactVersions.artifactId} = ${artifacts.id})`,
  ),
);

/** The key of a possible-duplicate group: type, exact name and the latest version's format. */
function duplicateKey(type: string, name: string, format: string): string {
  return `${type}\u0000${name}\u0000${format}`;
}

/** The others in an artifact's possible-duplicate group (FR-126-12); 0 outside any group. */
function otherDuplicates(
  groups: ReadonlyMap<string, number>,
  artifact: { type: string; name: string },
  format: string | undefined,
): number {
  const size =
    format === undefined
      ? undefined
      : groups.get(duplicateKey(artifact.type, artifact.name, format));
  return size === undefined ? 0 : size - 1;
}

/**
 * The size of every group of two or more artifacts with the same type, name and latest format
 * among `POSSIBLE_DUPLICATE_FORMATS` (FR-126-11), keyed by `duplicateKey`. One grouped statement
 * over all artifacts, walking `artifacts_type_name_idx` (NFR-126-02), whatever the list's filters:
 * a duplicate may be filtered out of the list and still count.
 */
async function possibleDuplicateGroups(db: Database): Promise<Map<string, number>> {
  const groups = await db
    .select({
      type: artifacts.type,
      name: artifacts.name,
      format: latestVersionRow.format,
      size: count(),
    })
    .from(artifacts)
    .innerJoin(latestVersionRow, isLatestVersion)
    .where(inArray(latestVersionRow.format, [...POSSIBLE_DUPLICATE_FORMATS]))
    .groupBy(artifacts.type, artifacts.name, latestVersionRow.format)
    .having(gt(count(), 1));
  return new Map(groups.map((g) => [duplicateKey(g.type, g.name, g.format), g.size]));
}

/**
 * The other artifacts of `artifact`'s possible-duplicate group (FR-126-13): at most
 * `MAX_LISTED_DUPLICATES`, oldest first (`created_at`, then `id`), with the total. A latest
 * format outside `POSSIBLE_DUPLICATE_FORMATS`, or no version, has none.
 */
async function readPossibleDuplicates(
  db: Database,
  artifact: { id: string; type: ArtifactType; name: string },
  latest: { format: string; contentHash: string } | undefined,
): Promise<{ items: PossibleDuplicate[]; total: number }> {
  if (!latest || !(POSSIBLE_DUPLICATE_FORMATS as readonly string[]).includes(latest.format)) {
    return { items: [], total: 0 };
  }
  // The type keeps `artifacts_type_name_idx` usable; the same format implies the same type.
  const sameGroup = and(
    eq(artifacts.type, artifact.type),
    eq(artifacts.name, artifact.name),
    ne(artifacts.id, artifact.id),
    eq(latestVersionRow.format, latest.format),
  );
  const listed = await db
    .select({
      id: artifacts.id,
      slug: artifacts.slug,
      name: artifacts.name,
      contentHash: latestVersionRow.contentHash,
      total: sql<number>`count(*) over ()`,
    })
    .from(artifacts)
    .innerJoin(latestVersionRow, isLatestVersion)
    .where(sameGroup)
    .orderBy(artifacts.createdAt, artifacts.id)
    .limit(MAX_LISTED_DUPLICATES);
  const [first] = listed;
  if (!first) return { items: [], total: 0 };
  // Every listed row carries the size of the whole group (a window over the unlimited result).
  const total = first.total;
  const active = await db
    .select({
      artifactId: artifactOccurrences.artifactId,
      repositoryId: repositories.id,
      repositoryName: repositories.name,
    })
    .from(artifactOccurrences)
    .innerJoin(repositories, eq(artifactOccurrences.repositoryId, repositories.id))
    .where(
      and(
        inArray(
          artifactOccurrences.artifactId,
          listed.map((row) => row.id),
        ),
        eq(artifactOccurrences.status, 'active'),
      ),
    )
    .orderBy(repositories.name, repositories.id);
  const items = listed.map((row) => {
    const found = active.filter((occurrence) => occurrence.artifactId === row.id);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      activeOccurrences: found.length,
      repositories: [
        ...new Map(
          found.map((o) => [o.repositoryId, { id: o.repositoryId, name: o.repositoryName }]),
        ).values(),
      ],
      sameLatestContent: row.contentHash === latest.contentHash,
    };
  });
  return { items, total };
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

/**
 * The SQL conditions of the artifacts list (every filter but `q`), shared by `listArtifacts` and
 * `listArtifactIds` so the bulk category action recomputes exactly the list the page showed
 * (SPEC-124 §8.2).
 */
function listConditions(db: Database, filter: ArtifactListFilter): SQL[] {
  const conditions: SQL[] = [];
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
  return conditions;
}

/**
 * The list's text search, folded as `matchesText` compares it; empty means no search. Text search
 * runs in JavaScript: SQLite's lower() folds ASCII only, `toLowerCase` folds all.
 */
function listTextQuery(filter: ArtifactListFilter): string {
  return filter.q?.trim().toLowerCase() ?? '';
}

export async function listArtifacts(
  db: Database,
  filter: ArtifactListFilter = {},
): Promise<ArtifactListItem[]> {
  const q = listTextQuery(filter);
  const rows = (
    await db
      .select()
      .from(artifacts)
      .where(and(...listConditions(db, filter)))
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
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      archivedAt: categories.archivedAt,
    })
    .from(artifactCategories)
    .innerJoin(categories, eq(artifactCategories.categoryId, categories.id))
    .where(inArray(artifactCategories.artifactId, ids))
    .orderBy(...assignedCategoryOrder);
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
  const duplicateGroups = await possibleDuplicateGroups(db);

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
      categories: categoriesOf(row.id).map(toArtifactCategory),
      repositories: [
        ...new Map(
          found.map((o) => [o.repositoryId, { id: o.repositoryId, name: o.name }]),
        ).values(),
      ],
      occurrenceCount: found.length,
      missing: found.length === 0,
      benchmarkCount: assignmentsOf(row.id).length,
      latestEvaluation: latest.get(row.id) ?? null,
      possibleDuplicates: otherDuplicates(duplicateGroups, row, latestVersion?.format),
    };
  });
}

/** Rows read per query while collecting listed ids, so the bulk path's memory stays bounded. */
const LISTED_ID_BATCH_SIZE = 1_000;

/**
 * The first `keep` ids the list shows for `filter`, in the list's order (name, then id), and
 * whether it lists more. Reads `id`, `name` and `description` in batches ordered as the list
 * (keyset on name and id) and matches `q` in JavaScript, so at most `keep` ids and one batch of
 * rows are held at a time; with `q` every row the SQL conditions leave can still be read
 * (SPEC-124 §8.2).
 */
async function collectListedIds(
  db: Database,
  filter: ArtifactListFilter,
  keep: number,
): Promise<{ ids: string[]; more: boolean }> {
  const conditions = listConditions(db, filter);
  const q = listTextQuery(filter);
  const ids: string[] = [];
  /** Where the next batch starts: after the last row read, in the list's order. */
  let after: SQL | undefined;
  for (;;) {
    const rows: { id: string; name: string; description: string | null }[] = await db
      .select({ id: artifacts.id, name: artifacts.name, description: artifacts.description })
      .from(artifacts)
      .where(and(...conditions, after))
      .orderBy(artifacts.name, artifacts.id)
      .limit(LISTED_ID_BATCH_SIZE);
    for (const row of rows) {
      if (q && !matchesText(row, q)) continue;
      if (ids.length === keep) return { ids, more: true };
      ids.push(row.id);
    }
    const last = rows[LISTED_ID_BATCH_SIZE - 1];
    if (!last) return { ids, more: false };
    after = or(
      gt(artifacts.name, last.name),
      and(eq(artifacts.name, last.name), gt(artifacts.id, last.id)),
    );
  }
}

/**
 * The ids `listArtifacts(db, filter)` lists, in the same order, without loading versions, runs
 * and occurrences (SPEC-124 §8.2): the bulk category action recomputes the list with it.
 */
export async function listArtifactIds(
  db: Database,
  filter: ArtifactListFilter = {},
): Promise<string[]> {
  return (await collectListedIds(db, filter, Number.POSITIVE_INFINITY)).ids;
}

/** The most artifacts one bulk category change acts on (SPEC-124 A16, NFR-106-01 sizing). */
export const MAX_BULK_CATEGORY_ARTIFACTS = 10_000;
/** Ids per `IN (…)` list of a bulk write, far below SQLite's bound-variable limit (32,766). */
const BULK_WRITE_BATCH_SIZE = 500;

export type BulkCategoryMode = 'assign' | 'remove';

export interface SetCategoryForListedArtifactsInput {
  categoryId: string;
  mode: BulkCategoryMode;
  /** The filters the page listed with, re-parsed on the server. */
  filter: ArtifactListFilter;
  /** `idListFingerprint` of the ids the page listed. */
  listFingerprint: string;
  /** Defaults to `MAX_BULK_CATEGORY_ARTIFACTS`; injectable for tests (SPEC-124 §15). */
  limit?: number;
}

export type SetCategoryForListedArtifactsOutcome =
  | { status: 'done'; changed: number; unchanged: number; category: CategoryRef }
  | { status: 'list-changed'; actualCount: number }
  | { status: 'category-archived'; category: CategoryRef }
  | { status: 'category-not-found' }
  | { status: 'too-many'; actualCount: number; limit: number };

function batches(ids: readonly string[]): string[][] {
  const result: string[][] = [];
  for (let start = 0; start < ids.length; start += BULK_WRITE_BATCH_SIZE) {
    result.push(ids.slice(start, start + BULK_WRITE_BATCH_SIZE));
  }
  return result;
}

/** Assigns an active category to the listed artifacts; returns how many were newly assigned. */
async function insertListedAssignments(
  db: Database,
  categoryId: string,
  ids: readonly string[],
): Promise<number> {
  const createdAt = nowIso();
  let changed = 0;
  for (const batch of batches(ids)) {
    const inserted = await db
      .insert(artifactCategories)
      .select(
        db
          .select({
            artifactId: sql<string>`${artifacts.id}`.as('artifact_id'),
            categoryId: sql<string>`${categories.id}`.as('category_id'),
            createdAt: sql<string>`${createdAt}`.as('created_at'),
          })
          .from(artifacts)
          .innerJoin(categories, eq(categories.id, categoryId))
          .where(and(inArray(artifacts.id, batch), isNull(categories.archivedAt))),
      )
      .onConflictDoNothing()
      .returning({ artifactId: artifactCategories.artifactId });
    changed += inserted.length;
  }
  return changed;
}

/** Removes a category from the listed artifacts; returns how many had it. */
async function deleteListedAssignments(
  db: Database,
  categoryId: string,
  ids: readonly string[],
): Promise<number> {
  let changed = 0;
  for (const batch of batches(ids)) {
    const removed = await db
      .delete(artifactCategories)
      .where(
        and(
          eq(artifactCategories.categoryId, categoryId),
          inArray(artifactCategories.artifactId, batch),
        ),
      )
      .returning({ artifactId: artifactCategories.artifactId });
    changed += removed.length;
  }
  return changed;
}

/**
 * Assigns or removes one active category for every artifact `filter` lists (SPEC-124 FR-124-13,
 * §8.2, D33). One `withTransaction` (`BEGIN IMMEDIATE`) recomputes the list with the shared list
 * conditions, then refuses, in this order: a list whose fingerprint differs from the one the page
 * posted, an unknown or archived category (both modes), more than `limit` artifacts. Otherwise it
 * inserts (`ON CONFLICT DO NOTHING`) or deletes in batches and counts the rows changed. Any
 * refusal, and any error, writes nothing. No artifact id comes from the browser.
 *
 * At most `limit + 1` ids are kept under the write lock: a list with even more cannot match a
 * page that offered the action (the page hides it above the limit, D28), so it is `list-changed`,
 * and its count is read after the transaction, outside the lock.
 */
export async function setCategoryForListedArtifacts(
  handle: DatabaseHandle,
  input: SetCategoryForListedArtifactsInput,
): Promise<SetCategoryForListedArtifactsOutcome> {
  const { categoryId, mode, filter, listFingerprint, limit = MAX_BULK_CATEGORY_ARTIFACTS } = input;
  const outcome = await withTransaction(
    handle,
    async (db): Promise<SetCategoryForListedArtifactsOutcome | null> => {
      const listed = await collectListedIds(db, filter, limit + 1);
      if (listed.more) return null;
      const { ids } = listed;
      // The page never offers the action on an empty list (D28), so an empty one has changed.
      if (ids.length === 0 || idListFingerprint(ids) !== listFingerprint) {
        return { status: 'list-changed', actualCount: ids.length };
      }
      const category = await readCategoryRef(db, categoryId);
      if (!category) return { status: 'category-not-found' };
      if (category.archived) return { status: 'category-archived', category };
      if (ids.length > limit) return { status: 'too-many', actualCount: ids.length, limit };
      const changed =
        mode === 'assign'
          ? await insertListedAssignments(db, categoryId, ids)
          : await deleteListedAssignments(db, categoryId, ids);
      // Read inside the write transaction, the category is the same after the write as before.
      return { status: 'done', changed, unchanged: ids.length - changed, category };
    },
  );
  return (
    outcome ?? {
      status: 'list-changed',
      actualCount: (await listArtifactIds(handle.db, filter)).length,
    }
  );
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
  // The repositories the versions were first seen in (FR-103-15). A version keeps its
  // provenance after its occurrence moves or disappears, so these are not the occurrences'.
  const sourceRepositories = await db
    .selectDistinct({
      id: repositories.id,
      name: repositories.name,
      provider: repositories.provider,
    })
    .from(artifactVersions)
    .innerJoin(repositories, eq(artifactVersions.sourceRepositoryId, repositories.id))
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(repositories.name, repositories.id);
  // Each occurrence with the number of the version it holds (SPEC-126 UD-3): copies diverge.
  const occurrences = await db
    .select({
      occurrence: artifactOccurrences,
      repository: repositories,
      version: artifactVersions.version,
    })
    .from(artifactOccurrences)
    .innerJoin(repositories, eq(artifactOccurrences.repositoryId, repositories.id))
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactOccurrences.latestVersionId))
    .where(eq(artifactOccurrences.artifactId, artifactId))
    .orderBy(repositories.name, repositories.id, artifactOccurrences.path);
  const cats = await db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      archivedAt: categories.archivedAt,
    })
    .from(artifactCategories)
    .innerJoin(categories, eq(artifactCategories.categoryId, categories.id))
    .where(eq(artifactCategories.artifactId, artifactId))
    .orderBy(...assignedCategoryOrder);
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
  // Missing: no active occurrence (SPEC-125 FR-125-08, A8). Last found: the latest `last_seen_at`
  // of its occurrences (ISO strings order as dates), or null when none is left.
  const missing = !occurrences.some(({ occurrence }) => occurrence.status === 'active');
  let lastFoundAt: string | null = null;
  if (missing) {
    for (const { occurrence } of occurrences) {
      if (lastFoundAt === null || occurrence.lastSeenAt > lastFoundAt) {
        lastFoundAt = occurrence.lastSeenAt;
      }
    }
  }
  const possibleDuplicates = await readPossibleDuplicates(db, artifact, versions[0]);
  return {
    artifact,
    missing,
    lastFoundAt,
    possibleDuplicates,
    versions,
    sourceRepositories,
    occurrences,
    categories: cats.map(toArtifactCategory),
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
