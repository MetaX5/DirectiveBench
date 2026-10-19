import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createId, nowIso, repositoryPathInputSchema } from '@directivebench/core';
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
} from '../schema';

export const benchmarkJobPayloadSchema = z
  .object({
    suiteVersionId: z.string().min(1),
    artifactVersionId: z.string().min(1),
  })
  .strict();
export type BenchmarkJobPayload = z.infer<typeof benchmarkJobPayloadSchema>;

/** Input of a `repository-registration` job: the path exactly as the user entered it (trimmed). */
export const repositoryRegistrationPayloadSchema = z
  .object({ path: repositoryPathInputSchema })
  .strict();
export type RepositoryRegistrationPayload = z.infer<typeof repositoryRegistrationPayloadSchema>;

/** Why the runner rejected a path (SPEC-104 §8 `RepositoryErrorCode`, local-path subset). */
export const REPOSITORY_REGISTRATION_ERROR_CODES = [
  'path-not-found',
  'not-a-directory',
  'permission-denied',
  'git-directory',
  'git-failed',
  'git-not-installed',
  'timeout',
] as const;
export type RepositoryRegistrationErrorCode = (typeof REPOSITORY_REGISTRATION_ERROR_CODES)[number];

/** Outcome of a `repository-registration` job, stored in `jobs.result` by the runner. */
export const repositoryRegistrationResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), repositoryId: z.string().min(1), created: z.boolean() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(REPOSITORY_REGISTRATION_ERROR_CODES),
      message: z.string().min(1),
    })
    .strict(),
]);
export type RepositoryRegistrationResult = z.infer<typeof repositoryRegistrationResultSchema>;

export type JobRecord = typeof jobs.$inferSelect;

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/** Validates references and enqueues a benchmark run. The web process only ever enqueues. */
export async function enqueueBenchmarkJob(
  db: Database,
  payload: BenchmarkJobPayload,
): Promise<JobRecord> {
  const parsed = benchmarkJobPayloadSchema.parse(payload);
  const suiteVersion = await db
    .select({ id: benchmarkSuiteVersions.id })
    .from(benchmarkSuiteVersions)
    .where(eq(benchmarkSuiteVersions.id, parsed.suiteVersionId))
    .get();
  if (!suiteVersion) throw new NotFoundError(`Suite version ${parsed.suiteVersionId} not found`);
  const artifactVersion = await db
    .select({ id: artifactVersions.id })
    .from(artifactVersions)
    .where(eq(artifactVersions.id, parsed.artifactVersionId))
    .get();
  if (!artifactVersion) {
    throw new NotFoundError(`Artifact version ${parsed.artifactVersionId} not found`);
  }
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
 * Enqueues the registration of a local path. The web process only enqueues: the runner resolves
 * the path, inspects it read-only and records the outcome in `jobs.result` (SPEC-104 §9).
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

/**
 * Atomically claims the oldest pending job. A single UPDATE … RETURNING guarantees that two
 * runners (or two loops) never claim the same job.
 */
export async function acquireNextJob(db: Database, runnerId: string): Promise<JobRecord | null> {
  const now = nowIso();
  const [job] = await db
    .update(jobs)
    .set({
      status: 'running',
      runnerId,
      startedAt: now,
      heartbeatAt: now,
      attempts: sql`${jobs.attempts} + 1`,
    })
    .where(
      and(
        eq(jobs.status, 'pending'),
        eq(
          jobs.id,
          sql`(select ${jobs.id} from ${jobs} where ${jobs.status} = 'pending' order by ${jobs.createdAt}, ${jobs.id} limit 1)`,
        ),
      ),
    )
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
  await db
    .update(jobs)
    .set({ status, error: error ?? null, result: result ?? null, finishedAt: nowIso() })
    .where(eq(jobs.id, jobId));
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
  /** The path as entered. */
  path: string;
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
    path: payload.data.path,
    error: job.error,
    result,
    repository,
  };
}
