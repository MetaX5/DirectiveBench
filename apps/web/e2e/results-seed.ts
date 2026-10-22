import type { DatabaseSync } from 'node:sqlite';

/**
 * Seeded benchmark runs for the results-by-version tests (issue #98, SPEC-118 §15 E2E): one
 * artifact with versions v1–v3, a `claude-code` suite, two comparability groups (subscription in
 * the user's profile, API key isolated), an A/B and a `none` baseline, and a version regression.
 * No agent runs here. Kept free of relative imports so it can also seed a manual check
 * (`node --experimental-strip-types`).
 */

/** The suite `directivebench demo` imports; its definition is reused with agent `claude-code`. */
const DEMO_SUITE_NAME = 'Input validation (mock agent demo)';

export const ARTIFACT = 'art_e2e98results';
export const SUITE = 'suite_e2e98';
const SUITE_VERSION = 'suitev_e2e98';
const KEY_SUBSCRIPTION = 'a'.repeat(64);
const KEY_API = 'b'.repeat(64);
export const RUN = {
  v1None: 'run_e2e98_v1_none',
  v2Ab: 'run_e2e98_v2_ab',
  v1Api: 'run_e2e98_v1_api',
  v2Api: 'run_e2e98_v2_api',
};

const subscriptionProfile = {
  authMode: 'subscription',
  isolationProfile: 'user-profile',
  permissionProfile: 'edit-only',
  flagsHash: 'f'.repeat(64),
  executionModel: 'claude-sonnet-4-6',
  hostId: 'e2e-host',
};
const apiProfile = {
  authMode: 'api-key',
  isolationProfile: 'isolated',
  permissionProfile: 'edit-and-shell',
  flagsHash: 'e'.repeat(64),
  executionModel: 'claude-sonnet-4-6',
};

function summary(options: {
  candidate: number;
  baseline: number;
  outcome: 'passed' | 'failed';
  verdict: string;
  profile: object;
  invocation?: object;
}) {
  const aggregate = (meanScore: number) => ({
    totalRuns: 1,
    validRuns: 1,
    meanScore,
    stdDev: null,
    minScore: meanScore,
    maxScore: meanScore,
    passRate: meanScore >= 1 ? 1 : 0,
    errorRate: 0,
    meanDurationMs: 1000,
  });
  return {
    baseline: aggregate(options.baseline),
    candidate: aggregate(options.candidate),
    delta: options.candidate - options.baseline,
    passRateDelta: 0,
    verdict: options.verdict,
    reasons: ['seeded'],
    candidateOutcome: options.outcome,
    confidence: { level: 'low', reason: 'one repetition' },
    deterministicAgent: false,
    nondeterministic: true,
    conclusive: false,
    cases: [],
    scoring: { passThreshold: 1, minDelta: 0.05 },
    repetitions: 1,
    displayStatus: options.outcome,
    environment: { kind: 'local-process', agentProfile: options.profile },
    ...(options.invocation ? { skillInvocation: options.invocation } : {}),
  };
}

function seed(db: DatabaseSync): void {
  const now = '2026-10-22T00:00:00.000Z';
  const fixture = (db.prepare('select id from fixture_versions limit 1').get() as { id: string })
    .id;
  const definition = (
    db
      .prepare(
        `select json_set(sv.definition, '$.execution.agent', 'claude-code') as definition
           from benchmark_suite_versions sv join benchmark_suites s on s.id = sv.suite_id
          where s.name = ? limit 1`,
      )
      .get(DEMO_SUITE_NAME) as { definition: string }
  ).definition;
  db.prepare(
    `insert into artifacts (id, slug, name, type, description, created_at, updated_at)
     values (?, 'e2e98-doc-skill', 'e2e98-doc-skill', 'skill', 'Seeded for results by version', ?, ?)`,
  ).run(ARTIFACT, now, now);
  const version = db.prepare(
    `insert into artifact_versions
       (id, artifact_id, version, content_hash, format, primary_file, files, parsed_metadata, created_at)
     values (?, ?, ?, ?, 'skill-md', 'SKILL.md', '[]', '{}', ?)`,
  );
  for (const n of [1, 2, 3]) version.run(`artv_e2e98_${n}`, ARTIFACT, n, String(n).repeat(64), now);
  db.prepare(
    `insert into benchmark_suites (id, slug, name, created_at, updated_at)
     values (?, 'e2e98-docs', 'E2E docs suite (claude-code)', ?, ?)`,
  ).run(SUITE, now, now);
  db.prepare(
    `insert into benchmark_suite_versions
       (id, suite_id, version, content_hash, schema_version, definition, fixtures, created_at)
     values (?, ?, 1, ?, 1, ?, '{}', ?)`,
  ).run(SUITE_VERSION, SUITE, 'c'.repeat(64), definition, now);

  const run = db.prepare(
    `insert into benchmark_runs
       (id, suite_version_id, artifact_version_id, baseline_artifact_version_id, agent_adapter_id,
        agent_version, model, environment, status, verdict, comparability_key, summary, warnings,
        started_at, finished_at)
     values (?, ?, ?, ?, 'claude-code', '2.1.302', null, '{}', 'completed', ?, ?, ?, ?, ?, ?)`,
  );
  const ambient = JSON.stringify(['ambient-user-config: 2/2 agent runs']);
  run.run(
    RUN.v1None,
    SUITE_VERSION,
    'artv_e2e98_1',
    null,
    'improved',
    KEY_SUBSCRIPTION,
    JSON.stringify(
      summary({
        candidate: 0.9,
        baseline: 0.2,
        outcome: 'passed',
        verdict: 'improved',
        profile: subscriptionProfile,
      }),
    ),
    ambient,
    '2026-10-01T10:00:00.000Z',
    '2026-10-01T10:05:00.000Z',
  );
  run.run(
    RUN.v2Ab,
    SUITE_VERSION,
    'artv_e2e98_2',
    'artv_e2e98_1',
    'unchanged',
    KEY_SUBSCRIPTION,
    JSON.stringify(
      summary({
        candidate: 0.5,
        baseline: 0.5,
        outcome: 'failed',
        verdict: 'unchanged',
        profile: subscriptionProfile,
        invocation: { baseline: { invoked: 1, runs: 1 }, candidate: { invoked: 0, runs: 1 } },
      }),
    ),
    ambient,
    '2026-10-02T10:00:00.000Z',
    '2026-10-02T10:05:00.000Z',
  );
  run.run(
    RUN.v1Api,
    SUITE_VERSION,
    'artv_e2e98_1',
    null,
    'improved',
    KEY_API,
    JSON.stringify(
      summary({
        candidate: 0.7,
        baseline: 0.1,
        outcome: 'failed',
        verdict: 'improved',
        profile: apiProfile,
      }),
    ),
    '[]',
    '2026-10-03T10:00:00.000Z',
    '2026-10-03T10:05:00.000Z',
  );
  run.run(
    RUN.v2Api,
    SUITE_VERSION,
    'artv_e2e98_2',
    null,
    'improved',
    KEY_API,
    JSON.stringify(
      summary({
        candidate: 0.8,
        baseline: 0.1,
        outcome: 'failed',
        verdict: 'improved',
        profile: apiProfile,
      }),
    ),
    '[]',
    '2026-10-04T10:00:00.000Z',
    '2026-10-04T10:05:00.000Z',
  );

  const agentRun = db.prepare(
    `insert into agent_runs
       (id, benchmark_run_id, case_id, variant, repetition, fixture_version_id, execution_status,
        score, passed, duration_ms, changed_files, trace, usage, error, created_at)
     values (?, ?, 'plan', ?, 1, ?, 'completed', 0.5, 0, 1000, '[]', ?, ?, null, ?)`,
  );
  const metadata = (invoked: boolean) =>
    JSON.stringify([
      {
        type: 'agent-metadata',
        metadata: {
          requestedModel: null,
          executionModel: 'claude-sonnet-4-6',
          reportedModels: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
        },
        skillActivation: {
          loaded: true,
          invoked,
          invocations: invoked ? 1 : 0,
          otherSkills: [],
        },
        errorCode: null,
        warnings: ['ambient-user-config'],
      },
      { type: 'tool-call', tool: 'Edit', callId: 't1' },
      { type: 'permission-denied', tool: 'Bash' },
    ]);
  agentRun.run(
    'arun_e2e98_b',
    RUN.v2Ab,
    'baseline',
    fixture,
    metadata(true),
    JSON.stringify({ inputTokens: 1234, outputTokens: 56 }),
    now,
  );
  agentRun.run('arun_e2e98_c', RUN.v2Ab, 'candidate', fixture, metadata(false), null, now);

  const assertion = db.prepare(
    `insert into assertion_results
       (id, agent_run_id, assertion_id, type, passed, score, weight, required, deterministic,
        message, details)
     values (?, 'arun_e2e98_c', ?, ?, 0, 0, 1, 0, 1, ?, ?)`,
  );
  assertion.run(
    'ares_e2e98_1',
    'structure',
    'markdown-sections',
    'Missing headings: Risks',
    JSON.stringify({
      file: 'plan.md',
      found: ['Assumptions', 'Estimate'],
      missing: ['Risks'],
      misordered: [],
    }),
  );
  assertion.run(
    'ares_e2e98_2',
    'mentions-pm',
    'required-phrases',
    'Pattern evaluation exceeded 2000 ms',
    JSON.stringify({
      error: { code: 'pattern-timeout', message: 'Pattern evaluation exceeded 2000 ms' },
      patterns: ['/(a+)+$/'],
    }),
  );
  assertion.run(
    'ares_e2e98_3',
    'hours',
    'markdown-table-value',
    'No number in cell "<b>bold</b>"',
    JSON.stringify({
      file: 'plan.md',
      row: '/Backend/i',
      column: 'Hours',
      tableIndex: 1,
      rowText: '| Backend | <b>bold</b> |',
      cell: '<b>bold</b>',
      value: null,
    }),
  );
}

/** Deletes the seeded runs by id (their agent runs and assertion results cascade). */
/** `ARTIFACT_RUNS_PAGE_LIMIT` in `@directivebench/database`: runs the artifact page loads. */
export const PAGE_LIMIT = 200;

/** Ids of the runs `seedNewerRuns` adds to fill the artifact page's window. */
export const NEWER_RUNS = Array.from(
  { length: PAGE_LIMIT },
  (_, i) => `run_e2e98_newer_${String(i).padStart(3, '0')}`,
);

/**
 * Fills the page window with `PAGE_LIMIT` newer completed runs of v3 in a third comparability
 * group, so the seeded v1/v2 runs fall outside it (Codex review of PR #112).
 */
export function seedNewerRuns(db: DatabaseSync): void {
  const insert = db.prepare(
    `insert into benchmark_runs
       (id, suite_version_id, artifact_version_id, agent_adapter_id, agent_version, environment,
        status, verdict, comparability_key, summary, warnings, started_at)
     values (?, 'suitev_e2e98', 'artv_e2e98_3', 'claude-code', '2.1.302', '{}', 'completed',
             'improved', ?, null, '[]', ?)`,
  );
  NEWER_RUNS.forEach((id, i) =>
    insert.run(id, 'd'.repeat(64), new Date(Date.UTC(2026, 9, 10) + i * 1000).toISOString()),
  );
}

export function deleteRuns(db: DatabaseSync): void {
  const remove = db.prepare('delete from benchmark_runs where id = ?');
  for (const id of [...Object.values(RUN), ...NEWER_RUNS]) remove.run(id);
}

export function cleanUp(db: DatabaseSync): void {
  // Runs first: they reference artifact versions without a cascade; agent runs and assertion
  // results cascade from them, suite versions from the suite, versions from the artifact.
  deleteRuns(db);
  db.prepare('delete from benchmark_suites where id = ?').run(SUITE);
  db.prepare('delete from artifacts where id = ?').run(ARTIFACT);
}

export function reseed(db: DatabaseSync): void {
  cleanUp(db);
  seed(db);
}
