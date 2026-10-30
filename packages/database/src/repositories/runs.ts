import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { createId, nowIso } from '@directivebench/core';
import { withTransaction, type Database, type DatabaseHandle } from '../client';
import {
  agentRunFiles,
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
/** One kept (or listed but not kept) output file of an agent run, with its content. */
export type AgentRunFileRecord = typeof agentRunFiles.$inferSelect;
/** The metadata of an output file, without its content (SPEC-123 §8.3). */
export type AgentRunFileSummary = Omit<AgentRunFileRecord, 'content'>;
/** An output file as the engine captured it, before it has an id (SPEC-123 FR-123-11). */
export type AgentRunFileInput = Omit<AgentRunFileRecord, 'id' | 'agentRunId'>;

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
  /**
   * Whether the output files were captured (SPEC-123 FR-123-11); true also when the agent changed
   * no file.
   */
  outputFilesKept: boolean;
  /** Redacted reason when the files were not kept, else null. */
  outputFilesReason: string | null;
  /** The captured files; empty when none were kept. */
  outputFiles: AgentRunFileInput[];
}

/**
 * Persists one agent run with its assertion results and its output files atomically
 * (SPEC-123 FR-123-11).
 */
export async function insertAgentRun(
  handle: DatabaseHandle,
  input: AgentRunInput,
): Promise<string> {
  const { assertions, outputFiles, ...run } = input;
  const id = createId('arun');
  await withTransaction(handle, async (db) => {
    await db.insert(agentRuns).values({ id, ...run, createdAt: nowIso() });
    for (const assertion of assertions) {
      await db
        .insert(assertionResults)
        .values({ id: createId('ares'), agentRunId: id, ...assertion });
    }
    for (const file of outputFiles) {
      await db.insert(agentRunFiles).values({ id: createId('afile'), agentRunId: id, ...file });
    }
  });
  return id;
}

/** The output files of an agent run without their content, ordered by path (SPEC-123 §8.3). */
export async function listAgentRunFiles(
  db: Database,
  agentRunId: string,
): Promise<AgentRunFileSummary[]> {
  return db
    .select({
      id: agentRunFiles.id,
      agentRunId: agentRunFiles.agentRunId,
      path: agentRunFiles.path,
      change: agentRunFiles.change,
      sizeBytes: agentRunFiles.sizeBytes,
      sha256: agentRunFiles.sha256,
      kept: agentRunFiles.kept,
      reason: agentRunFiles.reason,
      storedBytes: agentRunFiles.storedBytes,
      redactions: agentRunFiles.redactions,
    })
    .from(agentRunFiles)
    .where(eq(agentRunFiles.agentRunId, agentRunId))
    .orderBy(asc(agentRunFiles.path));
}

/** Counts of one agent run's output files, for the run page (SPEC-123 FR-123-20). */
export interface AgentRunFileCounts {
  agentRunId: string;
  /** Changed files listed, kept or not. */
  files: number;
  truncated: number;
  /** Files listed without content, deleted files included. */
  notKept: number;
  /** UTF-8 bytes of the kept content. */
  storedBytes: number;
}

/**
 * The output-file counts of every agent run of a benchmark run that has at least one listed file,
 * computed in SQL so no content is loaded (SPEC-123 FR-123-22).
 */
export async function countAgentRunFiles(
  db: Database,
  benchmarkRunId: string,
): Promise<AgentRunFileCounts[]> {
  const rows = await db
    .select({
      agentRunId: agentRunFiles.agentRunId,
      files: sql<number>`count(*)`,
      truncated: sql<number>`sum(case when ${agentRunFiles.kept} = 'truncated' then 1 else 0 end)`,
      notKept: sql<number>`sum(case when ${agentRunFiles.kept} = 'none' then 1 else 0 end)`,
      storedBytes: sql<number>`sum(${agentRunFiles.storedBytes})`,
    })
    .from(agentRunFiles)
    .innerJoin(agentRuns, eq(agentRunFiles.agentRunId, agentRuns.id))
    .where(eq(agentRuns.benchmarkRunId, benchmarkRunId))
    .groupBy(agentRunFiles.agentRunId)
    .orderBy(asc(agentRunFiles.agentRunId));
  return rows.map((row) => ({
    agentRunId: row.agentRunId,
    files: Number(row.files),
    truncated: Number(row.truncated),
    notKept: Number(row.notKept),
    storedBytes: Number(row.storedBytes),
  }));
}

/**
 * One output file with its content, or null when the agent run does not belong to the benchmark
 * run or has no file at that path (SPEC-123 §8.3, FR-123-22).
 */
export async function getAgentRunFile(
  db: Database,
  input: { benchmarkRunId: string; agentRunId: string; path: string },
): Promise<AgentRunFileRecord | null> {
  const [row] = await db
    .select({ file: agentRunFiles })
    .from(agentRunFiles)
    .innerJoin(agentRuns, eq(agentRunFiles.agentRunId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.benchmarkRunId, input.benchmarkRunId),
        eq(agentRunFiles.agentRunId, input.agentRunId),
        eq(agentRunFiles.path, input.path),
      ),
    );
  return row?.file ?? null;
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

/**
 * Most runs the artifact page loads (SPEC-118 FR-118-50): newest version first, then newest run.
 * Older runs are counted by `countArtifactRuns` and named in a notice, never loaded.
 */
export const ARTIFACT_RUNS_PAGE_LIMIT = 200;

/**
 * Most (version, comparability key) representatives `listVersionComparisonRuns` loads, newest
 * version first. A version regression needs one run per pair, not the whole history.
 */
export const ARTIFACT_VERSION_COMPARISON_LIMIT = 1000;

/** The parts of a run the results by version render (a lean projection; no traces, no cases). */
export interface ArtifactRunSummary {
  id: string;
  status: BenchmarkRunRecord['status'];
  verdict: string | null;
  comparabilityKey: string | null;
  agentAdapterId: string;
  agentVersion: string | null;
  model: BenchmarkRunRecord['model'];
  warnings: string[];
  startedAt: string;
  /**
   * Only `delta`, `verdict`, `candidateOutcome`, `candidate.meanScore`, `confidence.level`,
   * `scoring.minDelta` and `environment.agentProfile` of the stored summary (missing ones are
   * null); null when the run has no summary.
   */
  summary: Record<string, unknown> | null;
}

export interface ArtifactRunItem {
  run: ArtifactRunSummary;
  suite: { id: string; name: string; version: number };
  /** The candidate: the artifact version the run tested. */
  artifactVersion: { id: string; version: number };
  /** The A/B baseline version, or null for baseline kind `none` (SPEC-118 FR-118-13). */
  baselineVersion: { id: string; version: number } | null;
}

/** The lean summary: SQLite builds it, so the full summary JSON never leaves the database. */
const leanSummary = sql<Record<
  string,
  unknown
> | null>`case when ${benchmarkRuns.summary} is null then null else json_object(
  'delta', ${benchmarkRuns.summary} -> '$.delta',
  'verdict', ${benchmarkRuns.summary} -> '$.verdict',
  'candidateOutcome', ${benchmarkRuns.summary} -> '$.candidateOutcome',
  'candidate', json_object('meanScore', ${benchmarkRuns.summary} -> '$.candidate.meanScore'),
  'confidence', json_object('level', ${benchmarkRuns.summary} -> '$.confidence.level'),
  'scoring', json_object('minDelta', ${benchmarkRuns.summary} -> '$.scoring.minDelta'),
  'environment', json_object('agentProfile', ${benchmarkRuns.summary} -> '$.environment.agentProfile')
) end`.mapWith((value: string) => JSON.parse(value) as Record<string, unknown>);

/**
 * The newest `ARTIFACT_RUNS_PAGE_LIMIT` runs of one artifact, of any status, for the results by
 * version (SPEC-118 FR-118-50): newest candidate version first, then newest run first (`id` breaks
 * ties, so the order never depends on the storage order), with a lean projection.
 */
export async function listArtifactRuns(
  db: Database,
  artifactId: string,
): Promise<ArtifactRunItem[]> {
  const rows = await db
    .select({
      run: {
        id: benchmarkRuns.id,
        status: benchmarkRuns.status,
        verdict: benchmarkRuns.verdict,
        comparabilityKey: benchmarkRuns.comparabilityKey,
        agentAdapterId: benchmarkRuns.agentAdapterId,
        agentVersion: benchmarkRuns.agentVersion,
        model: benchmarkRuns.model,
        warnings: benchmarkRuns.warnings,
        startedAt: benchmarkRuns.startedAt,
        summary: leanSummary,
      },
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
    .orderBy(desc(artifactVersions.version), desc(benchmarkRuns.startedAt), desc(benchmarkRuns.id))
    .limit(ARTIFACT_RUNS_PAGE_LIMIT);
  return rows.map((r) => ({
    run: r.run,
    suite: { id: r.suiteId, name: r.suiteName, version: r.suiteVersion },
    artifactVersion: { id: r.versionId, version: r.version },
    baselineVersion: r.baselineVersion,
  }));
}

/** How many runs one artifact has, of any status (for "showing the latest N of M"). */
export async function countArtifactRuns(db: Database, artifactId: string): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(benchmarkRuns)
    .innerJoin(artifactVersions, eq(benchmarkRuns.artifactVersionId, artifactVersions.id))
    .where(eq(artifactVersions.artifactId, artifactId))
    .get();
  // An aggregate without GROUP BY always returns exactly one row.
  return Number((row as { count: number }).count);
}

/** The run a version regression compares for one (version, comparability key) pair. */
export interface VersionComparisonRun {
  runId: string;
  artifactVersionId: string;
  version: number;
  comparabilityKey: string;
  verdict: string | null;
  agentAdapterId: string;
  candidateMeanScore: number | null;
  candidateOutcome: string | null;
  minDelta: number;
}

/**
 * Per artifact version and comparability key, the latest run a version regression may use
 * (SPEC-111 FR-111-50): completed, keyed, verdict neither `error` nor `not-comparable`, with a
 * stored candidate aggregate and `scoring.minDelta`. Independent of the page window of
 * `listArtifactRuns`; bounded by `ARTIFACT_VERSION_COMPARISON_LIMIT` pairs, newest version first
 * (`truncated` when more exist, so the oldest versions lose their comparison, never a wrong one).
 */
export async function listVersionComparisonRuns(
  db: Database,
  artifactId: string,
): Promise<{ runs: VersionComparisonRun[]; truncated: boolean }> {
  // Rank ids and ordering columns only (the filters read the summary but nothing carries it),
  // keep the representatives, then read their summary fields: no sorter holds a summary (Codex
  // review of PR #113).
  const ranked = db
    .select({
      runId: sql<string>`${benchmarkRuns.id}`.as('run_id'),
      artifactVersionId: sql<string>`${artifactVersions.id}`.as('version_id'),
      version: sql<number>`${artifactVersions.version}`.as('version_number'),
      comparabilityKey: sql<string>`${benchmarkRuns.comparabilityKey}`.as('key'),
      rank: sql<number>`row_number() over (partition by ${benchmarkRuns.artifactVersionId}, ${benchmarkRuns.comparabilityKey} order by ${benchmarkRuns.startedAt} desc, ${benchmarkRuns.id} desc)`.as(
        'rank',
      ),
    })
    .from(benchmarkRuns)
    .innerJoin(artifactVersions, eq(benchmarkRuns.artifactVersionId, artifactVersions.id))
    .where(
      and(
        eq(artifactVersions.artifactId, artifactId),
        eq(benchmarkRuns.status, 'completed'),
        isNotNull(benchmarkRuns.comparabilityKey),
        sql`coalesce(${benchmarkRuns.verdict}, '') not in ('error', 'not-comparable')`,
        sql`json_type(${benchmarkRuns.summary}, '$.candidate') = 'object'`,
        sql`json_type(${benchmarkRuns.summary}, '$.scoring.minDelta') in ('integer', 'real')`,
      ),
    )
    .as('ranked');
  const representatives = db
    .select({
      runId: ranked.runId,
      artifactVersionId: ranked.artifactVersionId,
      version: ranked.version,
      comparabilityKey: ranked.comparabilityKey,
    })
    .from(ranked)
    .where(eq(ranked.rank, 1))
    .orderBy(desc(ranked.version), asc(ranked.comparabilityKey))
    .limit(ARTIFACT_VERSION_COMPARISON_LIMIT + 1)
    .as('representatives');
  const rows = await db
    .select({
      runId: representatives.runId,
      artifactVersionId: representatives.artifactVersionId,
      version: representatives.version,
      comparabilityKey: representatives.comparabilityKey,
      verdict: benchmarkRuns.verdict,
      agentAdapterId: benchmarkRuns.agentAdapterId,
      candidateMeanScore: sql<number | null>`${benchmarkRuns.summary} ->> '$.candidate.meanScore'`,
      candidateOutcome: sql<string | null>`${benchmarkRuns.summary} ->> '$.candidateOutcome'`,
      minDelta: sql<number>`${benchmarkRuns.summary} ->> '$.scoring.minDelta'`,
    })
    .from(representatives)
    .innerJoin(benchmarkRuns, eq(benchmarkRuns.id, representatives.runId))
    .orderBy(desc(representatives.version), asc(representatives.comparabilityKey));
  return {
    runs: rows.slice(0, ARTIFACT_VERSION_COMPARISON_LIMIT),
    truncated: rows.length > ARTIFACT_VERSION_COMPARISON_LIMIT,
  };
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
