import type { DatabaseSync } from 'node:sqlite';

/**
 * Seeded runs for the blind review (SPEC-123 §6.5, D46 to D57). Mock-agent runs on the demo
 * suite version, so the case prompt comes from the stored definition:
 *
 * - `BLIND_RUN`: completed, two eligible pairs (repetitions 1 and 2) and one excluded slot
 *   (repetition 3, candidate `agent-error`); no review, so a test starts it through the page.
 * - `REVIEWED_RUN`: the same agent runs with a review already inserted (unrevealed) and fixed
 *   sides: pair 1 has the candidate as A, pair 2 the baseline as A.
 * - `NO_PAIR_RUN`: completed, a baseline run only. `RUNNING_RUN`: still running.
 *
 * Kept free of relative imports so it can also seed a manual check.
 */

export const BLIND_RUN = 'run_e2e123_blind';
export const REVIEWED_RUN = 'run_e2e123_blind_reviewed';
export const NO_PAIR_RUN = 'run_e2e123_blind_nopair';
export const RUNNING_RUN = 'run_e2e123_blind_running';
export const REVIEW_ID = 'brev_e2e123_reviewed';

/** A trace fragment that must never reach a page while a review is unrevealed. */
export const TRACE_FRAGMENT = 'trace-fragment-e2e123-blind';
/** Agent-written markup that must render as text, never run (SPEC-123 §12). */
export const HOSTILE_LINE = '<img src=x onerror="window.__hostileBlind = 1">';
/** A path the artifact installed; never listed in a blind review (A7, FR-123-52). */
export const ARTIFACT_PATH = '.claude/skills/validate-external-input/SKILL.md';
/** The candidate's own path in repetition 1. */
export const CANDIDATE_ONLY_PATH = 'notes/candidate-only.md';

export const A_JS_BASELINE = 'export const answer = 1;\n';
export const A_JS_CANDIDATE = 'export const answer = 2;\nexport const extra = true;\n';

interface SeedFile {
  path: string;
  kept: 'full' | 'none';
  reason: 'artifact-path' | null;
  content: string | null;
  sha: string;
}

/** The agent-run ids of a seeded run, by variant and repetition. */
export function agentRunIds(runId: string) {
  const tag = runId.replace('run_e2e123_', '');
  return {
    baseline1: `arun_e2e123_${tag}_b1`,
    candidate1: `arun_e2e123_${tag}_c1`,
    baseline2: `arun_e2e123_${tag}_b2`,
    candidate2: `arun_e2e123_${tag}_c2`,
    baseline3: `arun_e2e123_${tag}_b3`,
    candidate3: `arun_e2e123_${tag}_c3`,
  };
}

const sameFile: SeedFile = {
  path: 'same.txt',
  kept: 'full',
  reason: null,
  content: 'identical output\n',
  sha: '5'.repeat(64),
};

function seedRun(
  db: DatabaseSync,
  runId: string,
  status: 'completed' | 'running',
  slots: 'pairs' | 'baseline-only',
): void {
  // Newer than the demo run, so `demoRunId` (the oldest run) still finds the demo.
  const now = new Date().toISOString();
  const demo = db
    .prepare(
      `select r.suite_version_id as suiteVersionId, r.artifact_version_id as artifactVersionId,
              a.case_id as caseId, a.fixture_version_id as fixture
         from benchmark_runs r join agent_runs a on a.benchmark_run_id = r.id
        order by r.started_at, r.id limit 1`,
    )
    .get() as {
    suiteVersionId: string;
    artifactVersionId: string;
    caseId: string;
    fixture: string;
  };
  db.prepare(
    `insert into benchmark_runs
       (id, suite_version_id, artifact_version_id, agent_adapter_id, agent_version, environment,
        status, verdict, comparability_key, summary, warnings, started_at, finished_at)
     values (?, ?, ?, 'mock', '1.0.0', '{}', ?, null, null, null, '[]', ?, ?)`,
  ).run(
    runId,
    demo.suiteVersionId,
    demo.artifactVersionId,
    status,
    now,
    status === 'running' ? null : now,
  );

  const agentRun = db.prepare(
    `insert into agent_runs
       (id, benchmark_run_id, case_id, variant, repetition, fixture_version_id, execution_status,
        score, passed, duration_ms, changed_files, trace, usage, error, created_at,
        output_files_kept, output_files_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, ?, ?, null, null, ?, 1, null)`,
  );
  const file = db.prepare(
    `insert into agent_run_files
       (id, agent_run_id, path, change, size_bytes, sha256, kept, reason, content, stored_bytes,
        redactions)
     values (?, ?, ?, 'added', ?, ?, ?, ?, ?, ?, 0)`,
  );
  const ids = agentRunIds(runId);
  const add = (
    id: string,
    variant: 'baseline' | 'candidate',
    repetition: number,
    executionStatus: string,
    files: SeedFile[],
  ) => {
    agentRun.run(
      id,
      runId,
      demo.caseId,
      variant,
      repetition,
      demo.fixture,
      executionStatus,
      variant === 'candidate' ? 1 : 0,
      variant === 'candidate' ? 1 : 0,
      JSON.stringify(files.map((f) => ({ path: f.path, change: 'added' }))),
      JSON.stringify([{ type: 'message', text: `${TRACE_FRAGMENT} ${variant} ${repetition}` }]),
      now,
    );
    files.forEach((f, i) =>
      file.run(
        `${id.replace('arun_', 'afile_')}_${i}`,
        id,
        f.path,
        Buffer.byteLength(f.content ?? 'x'),
        f.sha,
        f.kept,
        f.reason,
        f.content,
        f.content === null ? 0 : Buffer.byteLength(f.content),
      ),
    );
  };
  const artifactFile: SeedFile = {
    path: ARTIFACT_PATH,
    kept: 'none',
    reason: 'artifact-path',
    content: null,
    sha: '6'.repeat(64),
  };
  add(ids.baseline1, 'baseline', 1, 'completed', [
    {
      path: 'src/answer.js',
      kept: 'full',
      reason: null,
      content: A_JS_BASELINE,
      sha: '7'.repeat(64),
    },
  ]);
  if (slots === 'baseline-only') return;
  add(ids.candidate1, 'candidate', 1, 'completed', [
    artifactFile,
    {
      path: CANDIDATE_ONLY_PATH,
      kept: 'full',
      reason: null,
      content: `${HOSTILE_LINE}\n`,
      sha: '8'.repeat(64),
    },
    {
      path: 'src/answer.js',
      kept: 'full',
      reason: null,
      content: A_JS_CANDIDATE,
      sha: '9'.repeat(64),
    },
  ]);
  add(ids.baseline2, 'baseline', 2, 'completed', [sameFile]);
  add(ids.candidate2, 'candidate', 2, 'completed', [artifactFile, sameFile]);
  add(ids.baseline3, 'baseline', 3, 'completed', [sameFile]);
  add(ids.candidate3, 'candidate', 3, 'agent-error', []);
}

/** Inserts an unrevealed review of `REVIEWED_RUN` with fixed sides (pair 1: A is the candidate). */
function seedReview(db: DatabaseSync): void {
  const ids = agentRunIds(REVIEWED_RUN);
  const caseId = (
    db.prepare('select case_id as caseId from agent_runs where id = ?').get(ids.baseline1) as {
      caseId: string;
    }
  ).caseId;
  db.prepare(`insert into blind_reviews (id, benchmark_run_id, created_at) values (?, ?, ?)`).run(
    REVIEW_ID,
    REVIEWED_RUN,
    new Date().toISOString(),
  );
  const pair = db.prepare(
    `insert into blind_review_pairs (id, review_id, position, case_id, a_agent_run_id, b_agent_run_id)
     values (?, ?, ?, ?, ?, ?)`,
  );
  pair.run('bpair_e2e123_1', REVIEW_ID, 1, caseId, ids.candidate1, ids.baseline1);
  pair.run('bpair_e2e123_2', REVIEW_ID, 2, caseId, ids.baseline2, ids.candidate2);
}

const RUNS = [BLIND_RUN, REVIEWED_RUN, NO_PAIR_RUN, RUNNING_RUN];

/** Removes the seeded runs; agent runs, files, reviews and pairs cascade. */
export function cleanUp(db: DatabaseSync): void {
  const remove = db.prepare('delete from benchmark_runs where id = ?');
  for (const id of RUNS) remove.run(id);
}

export function reseed(db: DatabaseSync): void {
  cleanUp(db);
  seedRun(db, BLIND_RUN, 'completed', 'pairs');
  seedRun(db, REVIEWED_RUN, 'completed', 'pairs');
  seedRun(db, NO_PAIR_RUN, 'completed', 'baseline-only');
  seedRun(db, RUNNING_RUN, 'running', 'pairs');
  seedReview(db);
}
