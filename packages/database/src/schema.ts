import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/*
 * Portability rules (see .ai/specs/2026-10-14-database-schema.md):
 * - timestamps are ISO-8601 UTC text, IDs are prefixed random text
 * - structured data is JSON stored as text and validated at the boundary
 * - no SQLite-only features are relied upon by repository code except RETURNING (also in PostgreSQL)
 */

const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
};

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    predefined: integer('predefined', { mode: 'boolean' }).notNull().default(false),
    archivedAt: text('archived_at'),
    ...timestamps,
  },
  (t) => [uniqueIndex('categories_slug_unique').on(t.slug)],
);

/** A source of artifacts: hosted Git repository, local Git repository or plain local directory. */
export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    provider: text('provider', {
      enum: ['github', 'gitlab', 'local-git', 'local-directory', 'bundled-examples'],
    }).notNull(),
    name: text('name').notNull(),
    /** Clone URL for hosted providers, absolute path for local sources. */
    location: text('location').notNull(),
    /** Base URL of the provider instance (e.g. self-managed GitLab). */
    instanceUrl: text('instance_url'),
    defaultBranch: text('default_branch'),
    selectedBranch: text('selected_branch'),
    lastCommitSha: text('last_commit_sha'),
    lastSyncAt: text('last_sync_at'),
    syncStatus: text('sync_status', { enum: ['never', 'ok', 'error'] })
      .notNull()
      .default('never'),
    syncError: text('sync_error'),
    ...timestamps,
  },
  (t) => [uniqueIndex('repositories_provider_location_unique').on(t.provider, t.location)],
);

/** Logical artifact identity. Independent of where (and in how many repositories) it occurs. */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: ['skill', 'instruction', 'rule'] }).notNull(),
    description: text('description'),
    /** User-managed; never overwritten by synchronisation. */
    notes: text('notes'),
    tags: text('tags', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    ...timestamps,
  },
  (t) => [uniqueIndex('artifacts_slug_unique').on(t.slug)],
);

export interface StoredArtifactFile {
  path: string;
  sha256: string;
  size: number;
  content: string;
}

/** Immutable snapshot of an artifact's files. Rows are never updated after insertion. */
export const artifactVersions = sqliteTable(
  'artifact_versions',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    contentHash: text('content_hash').notNull(),
    format: text('format').notNull(),
    primaryFile: text('primary_file').notNull(),
    files: text('files', { mode: 'json' }).$type<StoredArtifactFile[]>().notNull(),
    parsedMetadata: text('parsed_metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    sourceRepositoryId: text('source_repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    sourcePath: text('source_path'),
    sourceCommitSha: text('source_commit_sha'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('artifact_versions_artifact_hash_unique').on(t.artifactId, t.contentHash),
    uniqueIndex('artifact_versions_artifact_version_unique').on(t.artifactId, t.version),
  ],
);

/** Where an artifact was found. One logical artifact may occur in several repositories. */
export const artifactOccurrences = sqliteTable(
  'artifact_occurrences',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    latestVersionId: text('latest_version_id')
      .notNull()
      .references(() => artifactVersions.id),
    commitSha: text('commit_sha'),
    status: text('status', { enum: ['active', 'removed'] })
      .notNull()
      .default('active'),
    lastSeenAt: text('last_seen_at').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('artifact_occurrences_repo_path_unique').on(t.repositoryId, t.path)],
);

export const artifactCategories = sqliteTable(
  'artifact_categories',
  {
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.categoryId] })],
);

/** Content-addressed fixture snapshot stored under `<dataDir>/fixtures/<id>`. */
export const fixtureVersions = sqliteTable('fixture_versions', {
  /** sha256 of the fixture's file manifest. */
  id: text('id').primaryKey(),
  sourcePath: text('source_path'),
  fileCount: integer('file_count').notNull(),
  totalBytes: integer('total_bytes').notNull(),
  createdAt: text('created_at').notNull(),
});

export const benchmarkSuites = sqliteTable(
  'benchmark_suites',
  {
    id: text('id').primaryKey(),
    /** The `id` field of the benchmark definition. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ...timestamps,
  },
  (t) => [uniqueIndex('benchmark_suites_slug_unique').on(t.slug)],
);

/** Immutable benchmark definition snapshot with resolved fixture versions. */
export const benchmarkSuiteVersions = sqliteTable(
  'benchmark_suite_versions',
  {
    id: text('id').primaryKey(),
    suiteId: text('suite_id')
      .notNull()
      .references(() => benchmarkSuites.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    contentHash: text('content_hash').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    /** Validated definition (JSON) as imported. */
    definition: text('definition', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** Fixture hashes per case: `{ [caseId]: { fixture, overlay? } }`. */
    fixtures: text('fixtures', { mode: 'json' })
      .$type<Record<string, { fixture: string; overlay?: string }>>()
      .notNull(),
    sourcePath: text('source_path'),
    /** Commands in this version may only run after explicit approval. */
    executionApprovedAt: text('execution_approved_at'),
    executionApprovalSource: text('execution_approval_source', {
      enum: ['bundled-example', 'user'],
    }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('benchmark_suite_versions_suite_hash_unique').on(t.suiteId, t.contentHash),
    uniqueIndex('benchmark_suite_versions_suite_version_unique').on(t.suiteId, t.version),
  ],
);

export const artifactBenchmarkAssignments = sqliteTable(
  'artifact_benchmark_assignments',
  {
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    suiteId: text('suite_id')
      .notNull()
      .references(() => benchmarkSuites.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.suiteId] })],
);

export const JOB_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const JOB_TYPES = ['benchmark-run', 'repository-registration'] as const;

/** Persistent local job queue (no Redis). */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: JOB_TYPES }).notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    /** Input of the job, validated per type at enqueue and again by the runner. */
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** Outcome recorded by the runner for job types that have one; validated per type on read. */
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
    runnerId: text('runner_id'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    cancelRequestedAt: text('cancel_requested_at'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    heartbeatAt: text('heartbeat_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [index('jobs_status_created_idx').on(t.status, t.createdAt)],
);

export const benchmarkRuns = sqliteTable(
  'benchmark_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    suiteVersionId: text('suite_version_id')
      .notNull()
      .references(() => benchmarkSuiteVersions.id),
    artifactVersionId: text('artifact_version_id')
      .notNull()
      .references(() => artifactVersions.id),
    agentAdapterId: text('agent_adapter_id').notNull(),
    agentVersion: text('agent_version'),
    model: text('model', { mode: 'json' }).$type<{ provider: string; model: string } | null>(),
    environment: text('environment', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    status: text('status', {
      enum: ['running', 'completed', 'error', 'cancelled', 'interrupted'],
    }).notNull(),
    /** Display verdict derived by the scoring module; null while running. */
    verdict: text('verdict'),
    comparabilityKey: text('comparability_key'),
    /** Scoring summary (aggregates per variant and case). */
    summary: text('summary', { mode: 'json' }).$type<Record<string, unknown>>(),
    warnings: text('warnings', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    error: text('error'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('benchmark_runs_artifact_version_idx').on(t.artifactVersionId),
    index('benchmark_runs_started_idx').on(t.startedAt),
  ],
);

/** One agent execution: a (case, variant, repetition) triple of a benchmark run. */
export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    benchmarkRunId: text('benchmark_run_id')
      .notNull()
      .references(() => benchmarkRuns.id, { onDelete: 'cascade' }),
    caseId: text('case_id').notNull(),
    variant: text('variant', { enum: ['baseline', 'candidate'] }).notNull(),
    repetition: integer('repetition').notNull(),
    fixtureVersionId: text('fixture_version_id').notNull(),
    executionStatus: text('execution_status', {
      enum: ['completed', 'agent-error', 'timeout', 'cancelled', 'infrastructure-error'],
    }).notNull(),
    score: real('score'),
    passed: integer('passed', { mode: 'boolean' }),
    durationMs: integer('duration_ms').notNull(),
    changedFiles: text('changed_files', { mode: 'json' })
      .$type<{ path: string; change: 'added' | 'modified' | 'deleted' }[]>()
      .notNull(),
    trace: text('trace', { mode: 'json' }).$type<unknown[]>().notNull(),
    usage: text('usage', { mode: 'json' }).$type<Record<string, number> | null>(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('agent_runs_benchmark_run_idx').on(t.benchmarkRunId)],
);

export const assertionResults = sqliteTable(
  'assertion_results',
  {
    id: text('id').primaryKey(),
    agentRunId: text('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    assertionId: text('assertion_id').notNull(),
    type: text('type').notNull(),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    score: real('score').notNull(),
    weight: real('weight').notNull(),
    required: integer('required', { mode: 'boolean' }).notNull(),
    deterministic: integer('deterministic', { mode: 'boolean' }).notNull(),
    message: text('message').notNull(),
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [index('assertion_results_agent_run_idx').on(t.agentRunId)],
);
