import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  baselineArtifactIssue,
  createId,
  hostedRepositoryLocationSchema,
  nowIso,
  repositoryLocationSchema,
  repositoryPathInputSchema,
} from '@directivebench/core';
import { withTransaction, type DatabaseHandle } from '../client';
import type { Database } from '../client';
import {
  artifacts,
  artifactVersions,
  benchmarkRuns,
  benchmarkSuites,
  benchmarkSuiteVersions,
  jobs,
  repositories,
  type JobStatus,
  type JobType,
} from '../schema';

/**
 * Input of a `benchmark-run` job (SPEC-118 §8.1). Strict, so a payload can never carry a field
 * that is not listed here — and none of these holds a secret value: `auth` names the mode, never
 * a key (the API key reaches only the agent's environment, FR-118-02).
 */
export const benchmarkJobPayloadSchema = z
  .object({
    suiteVersionId: z.string().min(1),
    /** The candidate. */
    artifactVersionId: z.string().min(1),
    /** The A/B baseline: another version of the same artifact; absent = baseline kind `none`. */
    baselineArtifactVersionId: z.string().min(1).optional(),
    /** How a real agent authenticates (SPEC-118 FR-118-02); absent for the mock agent. */
    auth: z
      .object({ mode: z.enum(['subscription', 'api-key']) })
      .strict()
      .optional(),
    /** Budget per agent session in USD, enforced by the agent only in API Key Mode (FR-118-30). */
    maxBudgetUsd: z.number().positive().finite().optional(),
  })
  .strict()
  .refine((payload) => payload.maxBudgetUsd === undefined || payload.auth?.mode === 'api-key', {
    message: 'maxBudgetUsd is accepted only with auth mode api-key',
    path: ['maxBudgetUsd'],
  });
export type BenchmarkJobPayload = z.infer<typeof benchmarkJobPayloadSchema>;

/**
 * Input of a `repository-registration` job. A local path: exactly as the user entered it
 * (trimmed) and, after a broad or overlapping-path notice, the canonical location the user
 * confirmed (SPEC-104 FR-104-18); the runner skips the notice only when the path still resolves to
 * that location. A hosted repository: its normalised, credential-free URL (FR-104-02, FR-104-05) —
 * never the text the user typed, so a payload cannot hold credentials.
 */
export const repositoryRegistrationPayloadSchema = z.union([
  z
    .object({
      path: repositoryPathInputSchema,
      confirmedLocation: repositoryLocationSchema.optional(),
    })
    .strict(),
  z.object({ url: hostedRepositoryLocationSchema }).strict(),
]);
export type RepositoryRegistrationPayload = z.infer<typeof repositoryRegistrationPayloadSchema>;

/** Why the runner rejected a path or URL (SPEC-104 §8 `RepositoryErrorCode`, implemented subset). */
export const REPOSITORY_REGISTRATION_ERROR_CODES = [
  'path-not-found',
  'not-a-directory',
  'permission-denied',
  'filesystem-root',
  'git-directory',
  'git-failed',
  'git-not-installed',
  'timeout',
  'invalid-url',
  'git-too-old',
  'auth-required',
  'unreachable',
  'branch-not-found',
  'cache-limit-exceeded',
] as const;
export type RepositoryRegistrationErrorCode = (typeof REPOSITORY_REGISTRATION_ERROR_CODES)[number];

/** A registered local repository that the new location contains or lies inside (FR-104-18). */
export const repositoryOverlapSchema = z
  .object({
    repositoryId: z.string().min(1),
    name: z.string(),
    location: z.string().min(1),
    /** `inside`: the new location is below this repository; `contains`: it is above it. */
    relation: z.enum(['inside', 'contains']),
  })
  .strict();
export type RepositoryOverlap = z.infer<typeof repositoryOverlapSchema>;

/**
 * Outcome of a `repository-registration` job, stored in `jobs.result` by the runner: registered,
 * rejected, or waiting for the user to confirm a broad or overlapping location (FR-104-18).
 */
export const repositoryRegistrationResultSchema = z.union([
  z.object({ ok: z.literal(true), repositoryId: z.string().min(1), created: z.boolean() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(REPOSITORY_REGISTRATION_ERROR_CODES),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.literal('confirmation-required'),
      /** The canonical location the user is asked to confirm. */
      location: repositoryLocationSchema,
      /** `home`: the location is the home directory; `contains-home`: it is above it. */
      home: z.enum(['home', 'contains-home']).nullable(),
      overlaps: z.array(repositoryOverlapSchema),
    })
    .strict(),
]);
export type RepositoryRegistrationResult = z.infer<typeof repositoryRegistrationResultSchema>;

/** Input of a `repository-scan` job (SPEC-105 FR-105-02). */
export const repositoryScanPayloadSchema = z.object({ repositoryId: z.string().min(1) }).strict();
export type RepositoryScanPayload = z.infer<typeof repositoryScanPayloadSchema>;

/** Why a scan did not run or did not finish; per-artifact problems are `errors` of a success. */
export const REPOSITORY_SCAN_ERROR_CODES = [
  'repository-not-found',
  'unsupported-provider',
  'filesystem-root',
  'location-changed',
  'path-not-found',
  'not-a-directory',
  'permission-denied',
  'scan-failed',
  'git-not-installed',
  'git-too-old',
  'auth-required',
  'unreachable',
  'timeout',
  'branch-not-found',
  'cache-limit-exceeded',
  'invalid-url',
  'git-failed',
] as const;
export type RepositoryScanErrorCode = (typeof REPOSITORY_SCAN_ERROR_CODES)[number];

/** Most discovery errors one scan result lists; the count is always complete. */
export const MAX_REPORTED_SCAN_ERRORS = 100;

/** Most skipped user-level folders one scan result lists (a handful exist per home directory). */
export const MAX_SKIPPED_USER_LEVEL_FOLDERS = 50;

/** A per-artifact discovery error (SPEC-102 `DiscoveryError`). */
export const scanDiscoveryErrorSchema = z
  .object({
    path: z.string(),
    code: z.enum(['too-large', 'binary-primary', 'symlink', 'too-many-files', 'read-failed']),
    message: z.string(),
  })
  .strict();

const count = z.number().int().nonnegative();

/** Outcome of a `repository-scan` job, stored in `jobs.result` by the runner. */
export const repositoryScanResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      scannedFiles: count,
      discovered: count,
      createdArtifacts: count,
      createdVersions: count,
      warningCount: count,
      errorCount: count,
      errors: z.array(scanDiscoveryErrorSchema).max(MAX_REPORTED_SCAN_ERRORS),
      /**
       * User-level agent folders the scan met and did not enter (D05), relative to the location;
       * `.` when the location itself is one. Informational, not errors. Absent in results stored
       * before it existed.
       */
      skippedUserLevelFolders: z.array(z.string()).max(MAX_SKIPPED_USER_LEVEL_FOLDERS).default([]),
      /**
       * The commit a hosted repository was read at (SPEC-105 FR-105-06); null for local scans,
       * which read the working tree. Absent in results stored before it existed.
       */
      commitSha: z
        .string()
        .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
        .nullable()
        .default(null),
      durationMs: count,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(REPOSITORY_SCAN_ERROR_CODES),
      message: z.string().min(1),
    })
    .strict(),
]);
export type RepositoryScanResult = z.infer<typeof repositoryScanResultSchema>;

/** Providers registered by local path (SPEC-104 FR-104-01, FR-104-03). */
export const LOCAL_PROVIDERS = ['local-git', 'local-directory'] as const;

/** Providers registered by URL; only public GitHub repositories so far (D06). */
export const HOSTED_PROVIDERS = ['github'] as const;

/** Providers a scan can read (SPEC-104 FR-104-01): local ones and public GitHub (#18). */
export const SCANNABLE_PROVIDERS = [...LOCAL_PROVIDERS, ...HOSTED_PROVIDERS] as const;

export type JobRecord = typeof jobs.$inferSelect;

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** The job was cancelled, interrupted or finished while its runner was still working on it. */
export class JobNoLongerRunningError extends Error {
  override name = 'JobNoLongerRunningError';
}

/** The A/B baseline of a benchmark job breaks SPEC-118 FR-118-12. */
export class InvalidBaselineError extends Error {
  override name = 'InvalidBaselineError';
}

async function artifactVersionIdentity(db: Database, versionId: string) {
  const row = await db
    .select({
      artifactId: artifactVersions.artifactId,
      versionId: artifactVersions.id,
      format: artifactVersions.format,
      contentHash: artifactVersions.contentHash,
    })
    .from(artifactVersions)
    .where(eq(artifactVersions.id, versionId))
    .get();
  if (!row) throw new NotFoundError(`Artifact version ${versionId} not found`);
  return row;
}

/**
 * Parses a benchmark job payload and checks what it references: the suite version, the
 * candidate and, when given, a baseline that is another version of the same artifact with other
 * content and the same format (SPEC-118 FR-118-12). Run it in the transaction that inserts the
 * job when the references could change meanwhile.
 */
async function checkedBenchmarkPayload(
  db: Database,
  payload: BenchmarkJobPayload,
): Promise<BenchmarkJobPayload> {
  const parsed = benchmarkJobPayloadSchema.parse(payload);
  const suiteVersion = await db
    .select({ id: benchmarkSuiteVersions.id })
    .from(benchmarkSuiteVersions)
    .where(eq(benchmarkSuiteVersions.id, parsed.suiteVersionId))
    .get();
  if (!suiteVersion) throw new NotFoundError(`Suite version ${parsed.suiteVersionId} not found`);
  const candidate = await artifactVersionIdentity(db, parsed.artifactVersionId);
  if (parsed.baselineArtifactVersionId !== undefined) {
    const baseline = await artifactVersionIdentity(db, parsed.baselineArtifactVersionId);
    const issue = baselineArtifactIssue(candidate, baseline);
    if (issue) throw new InvalidBaselineError(issue);
  }
  return parsed;
}

/** Validates references and enqueues a benchmark run. The web process only ever enqueues. */
export async function enqueueBenchmarkJob(
  db: Database,
  payload: BenchmarkJobPayload,
): Promise<JobRecord> {
  const parsed = await checkedBenchmarkPayload(db, payload);
  const [job] = await db
    .insert(jobs)
    .values({
      id: createId('job'),
      type: 'benchmark-run',
      status: 'pending',
      payload: parsed,
      createdAt: nowIso(),
    })
    .returning();
  if (!job) throw new Error('Failed to enqueue job');
  return job;
}

/**
 * Creates a benchmark job already acquired by `runnerId` (SPEC-118 FR-118-34): one INSERT of a
 * `running` row with its runner, start and heartbeat, so the job is never `pending` and no other
 * runner — e.g. `serve` polling the same data directory — can ever acquire it. The caller runs it
 * in-process (`LocalRunner.runAcquiredJob`) and keeps its heartbeat fresh; if the caller dies,
 * the stale-heartbeat recovery marks it `interrupted` (SPEC-114 FR-114-06). References are
 * checked first; `benchmark run` calls this inside the transaction that also imports the suite
 * version (FR-118-39), which makes check and insert atomic.
 */
export async function createAcquiredBenchmarkJob(
  db: Database,
  payload: BenchmarkJobPayload,
  runnerId: string,
  now: string,
): Promise<JobRecord> {
  const parsed = await checkedBenchmarkPayload(db, payload);
  const [job] = await db
    .insert(jobs)
    .values({
      id: createId('job'),
      type: 'benchmark-run',
      status: 'running',
      payload: parsed,
      runnerId,
      attempts: 1,
      createdAt: now,
      startedAt: now,
      heartbeatAt: now,
    })
    .returning();
  if (!job) throw new Error('Failed to create job');
  return job;
}

/**
 * Enqueues the registration of a local path or a hosted URL. The web process only enqueues: the
 * runner resolves the path or asks the remote, read-only, and records the outcome in
 * `jobs.result` (SPEC-104 §9).
 */
export async function enqueueRepositoryRegistrationJob(
  db: Database,
  payload: RepositoryRegistrationPayload,
): Promise<JobRecord> {
  const parsed = repositoryRegistrationPayloadSchema.parse(payload);
  const [job] = await db
    .insert(jobs)
    .values({
      id: createId('job'),
      type: 'repository-registration',
      status: 'pending',
      payload: parsed,
      createdAt: nowIso(),
    })
    .returning();
  if (!job) throw new Error('Failed to enqueue job');
  return job;
}

export class UnsupportedRepositoryError extends Error {
  override name = 'UnsupportedRepositoryError';
}

/**
 * Enqueues a scan of a registered local repository, or returns the scan already pending or
 * running for it (SPEC-105 FR-105-03). The check and the insert run in one transaction, so two
 * clicks cannot queue two scans. The web process only enqueues; the runner reads the files.
 */
export async function enqueueRepositoryScanJob(
  handle: DatabaseHandle,
  payload: RepositoryScanPayload,
): Promise<{ job: JobRecord; created: boolean }> {
  const parsed = repositoryScanPayloadSchema.parse(payload);
  return withTransaction(handle, async (db) => {
    const repository = await db
      .select({ provider: repositories.provider })
      .from(repositories)
      .where(eq(repositories.id, parsed.repositoryId))
      .get();
    if (!repository) throw new NotFoundError(`Repository ${parsed.repositoryId} not found`);
    if (!(SCANNABLE_PROVIDERS as readonly string[]).includes(repository.provider)) {
      throw new UnsupportedRepositoryError(
        `Repositories of provider ${repository.provider} cannot be scanned yet`,
      );
    }
    const active = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, 'repository-scan'), inArray(jobs.status, ['pending', 'running'])))
      .orderBy(jobs.createdAt, jobs.id);
    const existing = active.find(
      (job) =>
        repositoryScanPayloadSchema.safeParse(job.payload).data?.repositoryId ===
        parsed.repositoryId,
    );
    if (existing) return { job: existing, created: false };
    const [job] = await db
      .insert(jobs)
      .values({
        id: createId('job'),
        type: 'repository-scan',
        status: 'pending',
        payload: parsed,
        createdAt: nowIso(),
      })
      .returning();
    if (!job) throw new Error('Failed to enqueue job');
    return { job, created: true };
  });
}

/**
 * Atomically claims the oldest pending job, optionally only among `types` (the runner's lanes,
 * SPEC-114). A single UPDATE … RETURNING guarantees that two runners (or two loops) never claim
 * the same job.
 */
export async function acquireNextJob(
  db: Database,
  runnerId: string,
  options: { types?: readonly JobType[] } = {},
): Promise<JobRecord | null> {
  const now = nowIso();
  const next = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'pending'),
        options.types ? inArray(jobs.type, [...options.types]) : undefined,
      ),
    )
    .orderBy(jobs.createdAt, jobs.id)
    .limit(1);
  const [job] = await db
    .update(jobs)
    .set({
      status: 'running',
      runnerId,
      startedAt: now,
      heartbeatAt: now,
      attempts: sql`${jobs.attempts} + 1`,
    })
    .where(and(eq(jobs.status, 'pending'), inArray(jobs.id, next)))
    .returning();
  return job ?? null;
}

export async function heartbeatJob(db: Database, jobId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ heartbeatAt: nowIso() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')));
}

export async function finishJob(
  db: Database,
  jobId: string,
  status: Extract<JobStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
  error?: string,
  result?: Record<string, unknown>,
): Promise<void> {
  // Guarded (FR-114-14): a job that already reached a terminal state — e.g. marked `interrupted`
  // when a graceful shutdown timed out — is never overwritten by a late finish.
  await db
    .update(jobs)
    .set({ status, error: error ?? null, result: result ?? null, finishedAt: nowIso() })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['pending', 'running'])));
}

/**
 * Pending jobs are cancelled immediately. Running jobs get a cancellation request that the
 * runner observes and turns into `cancelled`. Finished jobs are left unchanged.
 */
export async function requestJobCancellation(
  db: Database,
  jobId: string,
): Promise<JobStatus | null> {
  const now = nowIso();
  await db
    .update(jobs)
    .set({ status: 'cancelled', cancelRequestedAt: now, finishedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'pending')));
  await db
    .update(jobs)
    .set({ cancelRequestedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), isNull(jobs.cancelRequestedAt)));
  const job = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get();
  return job?.status ?? null;
}

export async function isCancellationRequested(db: Database, jobId: string): Promise<boolean> {
  const job = await db
    .select({ at: jobs.cancelRequestedAt })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .get();
  return Boolean(job?.at);
}

/**
 * Crash recovery: `running` jobs whose heartbeat is older than `staleBefore` belong to a runner
 * that died. They become `interrupted` (never retried automatically) together with their runs.
 */
export async function recoverStaleJobs(db: Database, staleBefore: string): Promise<string[]> {
  const stale = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'running'),
        or(isNull(jobs.heartbeatAt), lt(jobs.heartbeatAt, staleBefore)),
      ),
    );
  return interruptJobs(
    db,
    stale.map((j) => j.id),
    'Runner stopped unexpectedly while the job was running',
  );
}

/**
 * Marks running jobs (and their running benchmark runs) as `interrupted`. Used for crash
 * recovery and when a graceful shutdown times out. Returns the ids that were changed.
 */
export async function interruptJobs(
  db: Database,
  jobIds: readonly string[],
  reason: string,
): Promise<string[]> {
  if (jobIds.length === 0) return [];
  const now = nowIso();
  const changed = await db
    .update(jobs)
    .set({ status: 'interrupted', finishedAt: now, error: reason })
    .where(and(inArray(jobs.id, [...jobIds]), eq(jobs.status, 'running')))
    .returning({ id: jobs.id });
  const ids = changed.map((j) => j.id);
  if (ids.length > 0) {
    await db
      .update(benchmarkRuns)
      .set({ status: 'interrupted', finishedAt: now, error: reason })
      .where(and(inArray(benchmarkRuns.jobId, ids), eq(benchmarkRuns.status, 'running')));
  }
  return ids;
}

export async function getJob(db: Database, jobId: string): Promise<JobRecord | null> {
  return (await db.select().from(jobs).where(eq(jobs.id, jobId)).get()) ?? null;
}

export interface JobListItem {
  job: JobRecord;
  suiteName: string | null;
  artifactName: string | null;
  benchmarkRunId: string | null;
}

/**
 * Benchmark jobs, newest first (the Executions page). Registration jobs are short-lived and shown
 * on the Repositories page instead (`getRepositoryRegistration`).
 */
export async function listJobs(db: Database, limit = 50): Promise<JobListItem[]> {
  const rows = await db
    .select()
    .from(jobs)
    .where(eq(jobs.type, 'benchmark-run'))
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
  const result: JobListItem[] = [];
  for (const job of rows) {
    const payload = benchmarkJobPayloadSchema.safeParse(job.payload);
    let suiteName: string | null = null;
    let artifactName: string | null = null;
    if (payload.success) {
      const suite = await db
        .select({ name: benchmarkSuites.name })
        .from(benchmarkSuiteVersions)
        .innerJoin(benchmarkSuites, eq(benchmarkSuiteVersions.suiteId, benchmarkSuites.id))
        .where(eq(benchmarkSuiteVersions.id, payload.data.suiteVersionId))
        .get();
      const artifact = await db
        .select({ name: artifacts.name })
        .from(artifactVersions)
        .innerJoin(artifacts, eq(artifactVersions.artifactId, artifacts.id))
        .where(eq(artifactVersions.id, payload.data.artifactVersionId))
        .get();
      suiteName = suite?.name ?? null;
      artifactName = artifact?.name ?? null;
    }
    const run = await db
      .select({ id: benchmarkRuns.id })
      .from(benchmarkRuns)
      .where(eq(benchmarkRuns.jobId, job.id))
      .get();
    result.push({ job, suiteName, artifactName, benchmarkRunId: run?.id ?? null });
  }
  return result;
}

export async function countJobsByStatus(db: Database): Promise<Record<JobStatus, number>> {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)` })
    .from(jobs)
    .groupBy(jobs.status);
  const counts: Record<JobStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  };
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

export interface RepositoryRegistration {
  jobId: string;
  status: JobStatus;
  /** The path as entered, or the normalised URL of a hosted repository. */
  input: string;
  /** Whether `input` is a local path or a hosted URL. */
  source: 'path' | 'url';
  /** The runner's message when the job failed outside path validation (e.g. invalid payload). */
  error: string | null;
  /** The runner's outcome; null until the job completes. */
  result: RepositoryRegistrationResult | null;
  /** The registered (or already registered) repository when `result.ok`. */
  repository: typeof repositories.$inferSelect | null;
}

/**
 * Reads a registration job for display. Returns null for an unknown id, another job type or a row
 * whose payload or result does not match its schema, so a page never renders unvalidated data.
 */
export async function getRepositoryRegistration(
  db: Database,
  jobId: string,
): Promise<RepositoryRegistration | null> {
  const job = await getJob(db, jobId);
  if (job?.type !== 'repository-registration') return null;
  const payload = repositoryRegistrationPayloadSchema.safeParse(job.payload);
  if (!payload.success) return null;
  let result: RepositoryRegistrationResult | null = null;
  if (job.result !== null) {
    const parsed = repositoryRegistrationResultSchema.safeParse(job.result);
    if (!parsed.success) return null;
    result = parsed.data;
  }
  const repository = result?.ok
    ? ((await db
        .select()
        .from(repositories)
        .where(eq(repositories.id, result.repositoryId))
        .get()) ?? null)
    : null;
  return {
    jobId: job.id,
    status: job.status,
    ...('url' in payload.data
      ? { input: payload.data.url, source: 'url' as const }
      : { input: payload.data.path, source: 'path' as const }),
    error: job.error,
    result,
    repository,
  };
}

export interface RepositoryScan {
  jobId: string;
  status: JobStatus;
  repositoryId: string;
  /** The runner's message when the job failed outside the scan itself (e.g. invalid payload). */
  error: string | null;
  /** The runner's outcome; null until the job completes. */
  result: RepositoryScanResult | null;
  /** The scanned repository; null when it no longer exists. */
  repository: typeof repositories.$inferSelect | null;
}

/**
 * Reads a scan job for display. Returns null for an unknown id, another job type or a row whose
 * payload or result does not match its schema, so a page never renders unvalidated data.
 */
export async function getRepositoryScan(
  db: Database,
  jobId: string,
): Promise<RepositoryScan | null> {
  const job = await getJob(db, jobId);
  if (job?.type !== 'repository-scan') return null;
  const payload = repositoryScanPayloadSchema.safeParse(job.payload);
  if (!payload.success) return null;
  let result: RepositoryScanResult | null = null;
  if (job.result !== null) {
    const parsed = repositoryScanResultSchema.safeParse(job.result);
    if (!parsed.success) return null;
    result = parsed.data;
  }
  const repository =
    (await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, payload.data.repositoryId))
      .get()) ?? null;
  return {
    jobId: job.id,
    status: job.status,
    repositoryId: payload.data.repositoryId,
    error: job.error,
    result,
    repository,
  };
}
