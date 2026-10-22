import { and, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import { createId, nowIso } from '@directivebench/core';
import { withTransaction, type Database, type DatabaseHandle } from '../client';
import {
  artifactBenchmarkAssignments,
  artifacts,
  benchmarkRuns,
  benchmarkSuites,
  benchmarkSuiteVersions,
  fixtureVersions,
} from '../schema';
import { createAcquiredBenchmarkJob, type BenchmarkJobPayload, type JobRecord } from './jobs';

export interface FixtureVersionInput {
  id: string;
  sourcePath: string | null;
  fileCount: number;
  totalBytes: number;
}

export async function recordFixtureVersion(
  db: Database,
  input: FixtureVersionInput,
): Promise<void> {
  await db
    .insert(fixtureVersions)
    .values({ ...input, createdAt: nowIso() })
    .onConflictDoNothing();
}

export interface ImportSuiteInput {
  slug: string;
  name: string;
  description: string | null;
  schemaVersion: number;
  definition: Record<string, unknown>;
  fixtures: Record<string, { fixture: string; overlay?: string }>;
  contentHash: string;
  sourcePath: string | null;
  /** Set only for trusted sources; user approval UX is planned. */
  approval: 'bundled-example' | null;
}

export interface ImportSuiteResult {
  suiteId: string;
  versionId: string;
  version: number;
  createdVersion: boolean;
}

/** Stores a benchmark definition as a new immutable suite version unless the content is known. */
export async function importSuiteVersion(
  handle: DatabaseHandle,
  input: ImportSuiteInput,
): Promise<ImportSuiteResult> {
  return withTransaction(handle, (db) => importSuiteVersionIn(db, input, nowIso()));
}

/** The body of {@link importSuiteVersion}, for callers that already hold a transaction. */
async function importSuiteVersionIn(
  db: Database,
  input: ImportSuiteInput,
  now: string,
): Promise<ImportSuiteResult> {
  let suite = await db
    .select({ id: benchmarkSuites.id })
    .from(benchmarkSuites)
    .where(eq(benchmarkSuites.slug, input.slug))
    .get();
  if (!suite) {
    suite = { id: createId('suite') };
    await db.insert(benchmarkSuites).values({
      id: suite.id,
      slug: input.slug,
      name: input.name,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db
      .update(benchmarkSuites)
      .set({ name: input.name, description: input.description, updatedAt: now })
      .where(eq(benchmarkSuites.id, suite.id));
  }

  const existing = await db
    .select({ id: benchmarkSuiteVersions.id, version: benchmarkSuiteVersions.version })
    .from(benchmarkSuiteVersions)
    .where(
      and(
        eq(benchmarkSuiteVersions.suiteId, suite.id),
        eq(benchmarkSuiteVersions.contentHash, input.contentHash),
      ),
    )
    .get();
  if (existing) {
    return {
      suiteId: suite.id,
      versionId: existing.id,
      version: existing.version,
      createdVersion: false,
    };
  }
  const current = await db
    .select({ value: max(benchmarkSuiteVersions.version) })
    .from(benchmarkSuiteVersions)
    .where(eq(benchmarkSuiteVersions.suiteId, suite.id))
    .get();
  const version = (current?.value ?? 0) + 1;
  const versionId = createId('suitev');
  await db.insert(benchmarkSuiteVersions).values({
    id: versionId,
    suiteId: suite.id,
    version,
    contentHash: input.contentHash,
    schemaVersion: input.schemaVersion,
    definition: input.definition,
    fixtures: input.fixtures,
    sourcePath: input.sourcePath,
    executionApprovedAt: input.approval ? now : null,
    executionApprovalSource: input.approval,
    createdAt: now,
  });
  return { suiteId: suite.id, versionId, version, createdVersion: true };
}

export async function getSuiteVersion(db: Database, versionId: string) {
  const row = await db
    .select({ version: benchmarkSuiteVersions, suite: benchmarkSuites })
    .from(benchmarkSuiteVersions)
    .innerJoin(benchmarkSuites, eq(benchmarkSuiteVersions.suiteId, benchmarkSuites.id))
    .where(eq(benchmarkSuiteVersions.id, versionId))
    .get();
  return row ?? null;
}

export type SuiteVersionRecord = NonNullable<Awaited<ReturnType<typeof getSuiteVersion>>>;

export async function listSuites(db: Database) {
  const suites = await db.select().from(benchmarkSuites).orderBy(benchmarkSuites.name);
  const ids = suites.map((s) => s.id);
  if (ids.length === 0) return [];
  const versions = await db
    .select()
    .from(benchmarkSuiteVersions)
    .where(inArray(benchmarkSuiteVersions.suiteId, ids))
    .orderBy(desc(benchmarkSuiteVersions.version));
  const assignments = await db
    .select({ suiteId: artifactBenchmarkAssignments.suiteId })
    .from(artifactBenchmarkAssignments)
    .where(inArray(artifactBenchmarkAssignments.suiteId, ids));
  const runs = await db
    .select({ suiteId: benchmarkSuiteVersions.suiteId, run: benchmarkRuns })
    .from(benchmarkRuns)
    .innerJoin(benchmarkSuiteVersions, eq(benchmarkRuns.suiteVersionId, benchmarkSuiteVersions.id))
    .where(inArray(benchmarkSuiteVersions.suiteId, ids))
    .orderBy(desc(benchmarkRuns.startedAt));
  return suites.map((suite) => {
    const latest = versions.find((v) => v.suiteId === suite.id) ?? null;
    return {
      suite,
      latestVersion: latest,
      assignedArtifactCount: assignments.filter((a) => a.suiteId === suite.id).length,
      lastRun: runs.find((r) => r.suiteId === suite.id)?.run ?? null,
      runCount: runs.filter((r) => r.suiteId === suite.id).length,
    };
  });
}

export async function getSuiteDetail(db: Database, suiteId: string) {
  const suite = await db
    .select()
    .from(benchmarkSuites)
    .where(eq(benchmarkSuites.id, suiteId))
    .get();
  if (!suite) return null;
  const versions = await db
    .select()
    .from(benchmarkSuiteVersions)
    .where(eq(benchmarkSuiteVersions.suiteId, suiteId))
    .orderBy(desc(benchmarkSuiteVersions.version));
  const assigned = await db
    .select({ id: artifacts.id, name: artifacts.name, slug: artifacts.slug, type: artifacts.type })
    .from(artifactBenchmarkAssignments)
    .innerJoin(artifacts, eq(artifactBenchmarkAssignments.artifactId, artifacts.id))
    .where(eq(artifactBenchmarkAssignments.suiteId, suiteId))
    .orderBy(artifacts.name);
  return { suite, versions, latestVersion: versions[0] ?? null, assignedArtifacts: assigned };
}

export type SuiteDetail = NonNullable<Awaited<ReturnType<typeof getSuiteDetail>>>;

/**
 * Approves a suite version for execution (SPEC-110 FR-110-46) with one conditional UPDATE: a
 * version that is already approved keeps its first approval. Returns whether this call approved it.
 */
export async function approveSuiteVersion(
  db: Database,
  suiteVersionId: string,
  source: 'user',
  now: string,
): Promise<boolean> {
  const updated = await db
    .update(benchmarkSuiteVersions)
    .set({ executionApprovedAt: now, executionApprovalSource: source })
    .where(
      and(
        eq(benchmarkSuiteVersions.id, suiteVersionId),
        isNull(benchmarkSuiteVersions.executionApprovedAt),
      ),
    )
    .returning({ id: benchmarkSuiteVersions.id });
  return updated.length > 0;
}

export interface BenchmarkRunJobInput {
  /** Fixture and overlay snapshots the suite version references. */
  fixtureVersions: readonly FixtureVersionInput[];
  /** The suite version as prepared from disk; stored unapproved unless `approval` says so. */
  suite: Omit<ImportSuiteInput, 'approval'>;
  /** `user`: `--approve-commands` was confirmed (FR-118-33). */
  approval: 'user' | null;
  /** The job payload without the suite version, which this transaction resolves. */
  payload: Omit<BenchmarkJobPayload, 'suiteVersionId'>;
  /** The CLI's own runner, which executes the job in-process (FR-118-34). */
  runnerId: string;
}

export interface BenchmarkRunJob {
  suite: ImportSuiteResult;
  job: JobRecord;
  /** Whether the suite version is approved for execution after this transaction. */
  executionApproved: boolean;
}

/**
 * The final step of `benchmark run` (SPEC-118 FR-118-39): one transaction records the fixture
 * versions, imports the suite version (an unchanged suite reuses its version, FR-118-23), records
 * approval source `user` when requested (FR-118-33) and creates the job already acquired by the
 * CLI's runner (FR-118-34). Any failure — e.g. an invalid baseline — rolls all of it back, so a
 * refused run leaves the database unchanged.
 */
export async function createBenchmarkRunJob(
  handle: DatabaseHandle,
  input: BenchmarkRunJobInput,
): Promise<BenchmarkRunJob> {
  return withTransaction(handle, async (db) => {
    const now = nowIso();
    for (const fixture of input.fixtureVersions) {
      await db
        .insert(fixtureVersions)
        .values({ ...fixture, createdAt: now })
        .onConflictDoNothing();
    }
    const suite = await importSuiteVersionIn(db, { ...input.suite, approval: null }, now);
    if (input.approval === 'user') await approveSuiteVersion(db, suite.versionId, 'user', now);
    const approved = await db
      .select({ at: benchmarkSuiteVersions.executionApprovedAt })
      .from(benchmarkSuiteVersions)
      .where(eq(benchmarkSuiteVersions.id, suite.versionId))
      .get();
    const job = await createAcquiredBenchmarkJob(
      db,
      { ...input.payload, suiteVersionId: suite.versionId },
      input.runnerId,
      now,
    );
    return { suite, job, executionApproved: Boolean(approved?.at) };
  });
}

/**
 * Whether the stored suite version with this content is approved for execution: `null` when no
 * such version is stored yet. `benchmark run` reads it before its final transaction to decide
 * whether `--approve-commands` is needed (FR-118-33); it writes nothing.
 */
export async function suiteVersionApproval(
  db: Database,
  slug: string,
  contentHash: string,
): Promise<boolean | null> {
  const row = await db
    .select({ at: benchmarkSuiteVersions.executionApprovedAt })
    .from(benchmarkSuiteVersions)
    .innerJoin(benchmarkSuites, eq(benchmarkSuiteVersions.suiteId, benchmarkSuites.id))
    .where(and(eq(benchmarkSuites.slug, slug), eq(benchmarkSuiteVersions.contentHash, contentHash)))
    .get();
  return row ? row.at !== null : null;
}
