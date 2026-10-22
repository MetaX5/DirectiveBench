import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { createId, nowIso } from '@directivebench/core';
import { withTransaction, type Database, type DatabaseHandle } from '../client';
import {
  agentRuns,
  artifacts,
  artifactVersions,
  assertionResults,
  benchmarkRuns,
  benchmarkSuites,
  benchmarkSuiteVersions,
} from '../schema';

export type BenchmarkRunRecord = typeof benchmarkRuns.$inferSelect;
export type AgentRunRecord = typeof agentRuns.$inferSelect;
export type AssertionResultRecord = typeof assertionResults.$inferSelect;

export interface CreateBenchmarkRunInput {
  jobId: string | null;
  suiteVersionId: string;
  artifactVersionId: string;
  /** The A/B baseline version, or null for baseline kind `none` (SPEC-118 FR-118-13). */
  baselineArtifactVersionId: string | null;
  agentAdapterId: string;
  agentVersion: string | null;
  model: { provider: string; model: string } | null;
  environment: Record<string, unknown>;
}

export async function createBenchmarkRun(
  db: Database,
  input: CreateBenchmarkRunInput,
): Promise<string> {
  const id = createId('run');
  await db.insert(benchmarkRuns).values({
    id,
    ...input,
    status: 'running',
    startedAt: nowIso(),
  });
  return id;
}

export interface AgentRunInput {
  benchmarkRunId: string;
  caseId: string;
  variant: 'baseline' | 'candidate';
  repetition: number;
  fixtureVersionId: string;
  executionStatus: AgentRunRecord['executionStatus'];
  score: number | null;
  passed: boolean | null;
  durationMs: number;
  changedFiles: AgentRunRecord['changedFiles'];
  trace: unknown[];
  usage: Record<string, number> | null;
  error: string | null;
  assertions: Omit<AssertionResultRecord, 'id' | 'agentRunId'>[];
}

/** Persists one agent run with its assertion results atomically. */
export async function insertAgentRun(
  handle: DatabaseHandle,
  input: AgentRunInput,
): Promise<string> {
  const { assertions, ...run } = input;
  const id = createId('arun');
  await withTransaction(handle, async (db) => {
    await db.insert(agentRuns).values({ id, ...run, createdAt: nowIso() });
    for (const assertion of assertions) {
      await db
        .insert(assertionResults)
        .values({ id: createId('ares'), agentRunId: id, ...assertion });
    }
  });
  return id;
}

export interface FinishBenchmarkRunInput {
  status: Exclude<BenchmarkRunRecord['status'], 'running'>;
  verdict: string | null;
  summary: Record<string, unknown> | null;
  comparabilityKey: string | null;
  warnings: string[];
  error: string | null;
}

export async function finishBenchmarkRun(
  db: Database,
  runId: string,
  input: FinishBenchmarkRunInput,
): Promise<void> {
  await db
    .update(benchmarkRuns)
    .set({ ...input, finishedAt: nowIso() })
    .where(eq(benchmarkRuns.id, runId));
}

export interface BenchmarkRunListItem {
  run: BenchmarkRunRecord;
  suite: { id: string; name: string; version: number };
  artifact: { id: string; name: string; version: number };
}

export async function listBenchmarkRuns(
  db: Database,
  options: { limit?: number; suiteId?: string } = {},
): Promise<BenchmarkRunListItem[]> {
  const query = db
    .select({
      run: benchmarkRuns,
      suiteId: benchmarkSuites.id,
      suiteName: benchmarkSuites.name,
      suiteVersion: benchmarkSuiteVersions.version,
      artifactId: artifacts.id,
      artifactName: artifacts.name,
      artifactVersion: artifactVersions.version,
    })
    .from(benchmarkRuns)
    .innerJoin(benchmarkSuiteVersions, eq(benchmarkRuns.suiteVersionId, benchmarkSuiteVersions.id))
    .innerJoin(benchmarkSuites, eq(benchmarkSuiteVersions.suiteId, benchmarkSuites.id))
    .innerJoin(artifactVersions, eq(benchmarkRuns.artifactVersionId, artifactVersions.id))
    .innerJoin(artifacts, eq(artifactVersions.artifactId, artifacts.id))
    .orderBy(desc(benchmarkRuns.startedAt))
    .limit(options.limit ?? 50);
  const rows = options.suiteId
    ? await query.where(eq(benchmarkSuites.id, options.suiteId))
    : await query;
  return rows.map((r) => ({
    run: r.run,
    suite: { id: r.suiteId, name: r.suiteName, version: r.suiteVersion },
    artifact: { id: r.artifactId, name: r.artifactName, version: r.artifactVersion },
  }));
}

/** The A/B baseline version of a run, joined beside the candidate version (SPEC-118 FR-118-13). */
const baselineVersions = alias(artifactVersions, 'baseline_versions');

export async function getBenchmarkRunDetail(db: Database, runId: string) {
  const row = await db
    .select({
      run: benchmarkRuns,
      suiteVersion: benchmarkSuiteVersions,
      suite: benchmarkSuites,
      artifactVersion: artifactVersions,
      artifact: artifacts,
      /** Null for baseline kind `none` (no artifact in the baseline workspaces). */
      baselineArtifactVersion: {
        id: baselineVersions.id,
        version: baselineVersions.version,
        contentHash: baselineVersions.contentHash,
      },
    })
    .from(benchmarkRuns)
    .innerJoin(benchmarkSuiteVersions, eq(benchmarkRuns.suiteVersionId, benchmarkSuiteVersions.id))
    .innerJoin(benchmarkSuites, eq(benchmarkSuiteVersions.suiteId, benchmarkSuites.id))
    .innerJoin(artifactVersions, eq(benchmarkRuns.artifactVersionId, artifactVersions.id))
    .innerJoin(artifacts, eq(artifactVersions.artifactId, artifacts.id))
    .leftJoin(baselineVersions, eq(benchmarkRuns.baselineArtifactVersionId, baselineVersions.id))
    .where(eq(benchmarkRuns.id, runId))
    .get();
  if (!row) return null;
  const runs = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.benchmarkRunId, runId))
    .orderBy(asc(agentRuns.caseId), asc(agentRuns.repetition), asc(agentRuns.variant));
  const ids = runs.map((r) => r.id);
  const assertions =
    ids.length === 0
      ? []
      : await db.select().from(assertionResults).where(inArray(assertionResults.agentRunId, ids));
  return {
    ...row,
    agentRuns: runs.map((run) => ({
      ...run,
      assertions: assertions.filter((a) => a.agentRunId === run.id),
    })),
  };
}

export type BenchmarkRunDetail = NonNullable<Awaited<ReturnType<typeof getBenchmarkRunDetail>>>;

export interface ArtifactRunItem {
  run: BenchmarkRunRecord;
  suite: { id: string; name: string; version: number };
  /** The candidate: the artifact version the run tested. */
  artifactVersion: { id: string; version: number };
  /** The A/B baseline version, or null for baseline kind `none` (SPEC-118 FR-118-13). */
  baselineVersion: { id: string; version: number } | null;
}

/**
 * Every benchmark run of one artifact, of any status, for the results by version (SPEC-118
 * FR-118-50): newest candidate version first, then newest run first (`id` breaks ties, so the
 * order never depends on the storage order).
 */
export async function listArtifactRuns(
  db: Database,
  artifactId: string,
): Promise<ArtifactRunItem[]> {
  const rows = await db
    .select({
      run: benchmarkRuns,
      suiteId: benchmarkSuites.id,
      suiteName: benchmarkSuites.name,
      suiteVersion: benchmarkSuiteVersions.version,
      versionId: artifactVersions.id,
      version: artifactVersions.version,
      baselineVersion: { id: baselineVersions.id, version: baselineVersions.version },
    })
    .from(benchmarkRuns)
    .innerJoin(artifactVersions, eq(benchmarkRuns.artifactVersionId, artifactVersions.id))
    .innerJoin(benchmarkSuiteVersions, eq(benchmarkRuns.suiteVersionId, benchmarkSuiteVersions.id))
    .innerJoin(benchmarkSuites, eq(benchmarkSuiteVersions.suiteId, benchmarkSuites.id))
    .leftJoin(baselineVersions, eq(benchmarkRuns.baselineArtifactVersionId, baselineVersions.id))
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.version), desc(benchmarkRuns.startedAt), desc(benchmarkRuns.id));
  return rows.map((r) => ({
    run: r.run,
    suite: { id: r.suiteId, name: r.suiteName, version: r.suiteVersion },
    artifactVersion: { id: r.versionId, version: r.version },
    baselineVersion: r.baselineVersion,
  }));
}

export async function countRunsByVerdict(db: Database): Promise<Record<string, number>> {
  const rows = await db
    .select({
      verdict: benchmarkRuns.verdict,
      status: benchmarkRuns.status,
      count: sql<number>`count(*)`,
    })
    .from(benchmarkRuns)
    .groupBy(benchmarkRuns.verdict, benchmarkRuns.status);
  const result: Record<string, number> = {};
  for (const row of rows) {
    const key = row.verdict ?? row.status;
    result[key] = (result[key] ?? 0) + Number(row.count);
  }
  return result;
}
