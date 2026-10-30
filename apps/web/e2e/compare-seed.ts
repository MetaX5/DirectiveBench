import type { DatabaseSync } from 'node:sqlite';

/**
 * Seeded agent runs for the compare page (SPEC-123 FR-123-30 to FR-123-32, D36 to D45). One
 * mock-agent benchmark run with two cases: `compare-case` has a baseline and a candidate run
 * whose files cover identical, differing, one-side-only, deleted, binary and too-large pairs,
 * plus a candidate repetition 2 whose files were not kept; `lonely-case` has one baseline run
 * only. Kept free of relative imports so it can also seed a manual check.
 */

export const COMPARE_RUN = 'run_e2e123_compare';
/** A run with no agent run recorded yet (the compare page's "none" state). */
export const EMPTY_RUN = 'run_e2e123_cmp_empty';
export const COMPARE_CASE = 'compare-case';
export const LONELY_CASE = 'lonely-case';
export const COMPARE_AGENT_RUN = {
  baseline: 'arun_e2e123_cmp_base',
  candidate: 'arun_e2e123_cmp_cand',
  notKept: 'arun_e2e123_cmp_notkept',
  lonely: 'arun_e2e123_cmp_lonely',
};
export const NOT_KEPT_REASON = 'the workspace was replaced after the agent run';

/** Agent-written markup that must render as text in a diff, never run (SPEC-123 §12). */
export const HOSTILE_LINE = '<img src=x onerror="window.__hostileCompare = 1">';

interface SeedFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  kept: 'full' | 'none';
  reason: 'binary' | 'deleted' | null;
  content: string | null;
  sha: string | null;
}

const lines = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

const shared = 'export const same = 1;\n';

/**
 * PHP on both sides, so the diff shows syntax colours on its removed and added rows
 * (SPEC-123 FR-123-76, AC-12, AC-14): line 2 changed, line 4 added.
 */
export const RENDER_LEFT = "<?php\n$label = 'Close';\necho esc_html( $label ); // render\n";
export const RENDER_RIGHT =
  "<?php\n$label = __( 'Close notice', 'notice-block' );\necho esc_html( $label ); // render\nreturn 1;\n";

/** Files of the baseline run, by path. */
export const LEFT_FILES: SeedFile[] = [
  {
    path: 'deleted.txt',
    change: 'deleted',
    kept: 'none',
    reason: 'deleted',
    content: null,
    sha: null,
  },
  {
    path: 'huge.txt',
    change: 'added',
    kept: 'full',
    reason: null,
    content: lines('left', 600),
    sha: 'b'.repeat(64),
  },
  {
    path: 'only-left.txt',
    change: 'added',
    kept: 'full',
    reason: null,
    content: 'left only\n',
    sha: 'c'.repeat(64),
  },
  {
    path: 'pic.png',
    change: 'added',
    kept: 'none',
    reason: 'binary',
    content: null,
    sha: 'd'.repeat(64),
  },
  {
    path: 'same.js',
    change: 'added',
    kept: 'full',
    reason: null,
    content: shared,
    sha: 'e'.repeat(64),
  },
  {
    path: 'src/render.php',
    change: 'modified',
    kept: 'full',
    reason: null,
    content: RENDER_LEFT,
    sha: 'f'.repeat(64),
  },
];

/** Files of the candidate run, by path. */
export const RIGHT_FILES: SeedFile[] = [
  {
    path: 'deleted.txt',
    change: 'deleted',
    kept: 'none',
    reason: 'deleted',
    content: null,
    sha: null,
  },
  {
    path: 'huge.txt',
    change: 'added',
    kept: 'full',
    reason: null,
    content: lines('right', 600),
    sha: '1'.repeat(64),
  },
  {
    path: 'only-right.md',
    change: 'added',
    kept: 'full',
    reason: null,
    content: `${HOSTILE_LINE}\n`,
    sha: '2'.repeat(64),
  },
  {
    path: 'pic.png',
    change: 'added',
    kept: 'full',
    reason: null,
    content: 'now text\n',
    sha: '3'.repeat(64),
  },
  {
    path: 'same.js',
    change: 'added',
    kept: 'full',
    reason: null,
    content: shared,
    sha: 'e'.repeat(64),
  },
  {
    path: 'src/render.php',
    change: 'modified',
    kept: 'full',
    reason: null,
    content: RENDER_RIGHT,
    sha: '4'.repeat(64),
  },
];

function seed(db: DatabaseSync): void {
  // Newer than the demo run, so `demoRunId` (the oldest run) still finds the demo.
  const now = new Date().toISOString();
  const ids = db
    .prepare(
      `select suite_version_id as suiteVersionId, artifact_version_id as artifactVersionId
         from benchmark_runs order by started_at, id limit 1`,
    )
    .get() as { suiteVersionId: string; artifactVersionId: string };
  const fixture = (db.prepare('select id from fixture_versions limit 1').get() as { id: string })
    .id;
  const run = db.prepare(
    `insert into benchmark_runs
       (id, suite_version_id, artifact_version_id, agent_adapter_id, agent_version, environment,
        status, verdict, comparability_key, summary, warnings, started_at, finished_at)
     values (?, ?, ?, 'mock', '1.0.0', '{}', 'completed', null, null, null, '[]', ?, ?)`,
  );
  for (const id of [COMPARE_RUN, EMPTY_RUN]) {
    run.run(id, ids.suiteVersionId, ids.artifactVersionId, now, now);
  }
  const agentRun = db.prepare(
    `insert into agent_runs
       (id, benchmark_run_id, case_id, variant, repetition, fixture_version_id, execution_status,
        score, passed, duration_ms, changed_files, trace, usage, error, created_at,
        output_files_kept, output_files_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, ?, '[]', null, null, ?, ?, ?)`,
  );
  const changed = (files: SeedFile[]) =>
    JSON.stringify(files.map((f) => ({ path: f.path, change: f.change })));
  // Inserted candidate first, so the page must order the selects itself.
  agentRun.run(
    COMPARE_AGENT_RUN.candidate,
    COMPARE_RUN,
    COMPARE_CASE,
    'candidate',
    1,
    fixture,
    'completed',
    1,
    1,
    changed(RIGHT_FILES),
    now,
    1,
    null,
  );
  agentRun.run(
    COMPARE_AGENT_RUN.baseline,
    COMPARE_RUN,
    COMPARE_CASE,
    'baseline',
    1,
    fixture,
    'completed',
    0,
    0,
    changed(LEFT_FILES),
    now,
    1,
    null,
  );
  agentRun.run(
    COMPARE_AGENT_RUN.notKept,
    COMPARE_RUN,
    COMPARE_CASE,
    'candidate',
    2,
    fixture,
    'infrastructure-error',
    null,
    null,
    '[]',
    now,
    0,
    NOT_KEPT_REASON,
  );
  agentRun.run(
    COMPARE_AGENT_RUN.lonely,
    COMPARE_RUN,
    LONELY_CASE,
    'baseline',
    1,
    fixture,
    'completed',
    1,
    1,
    changed([LEFT_FILES[4]!]),
    now,
    1,
    null,
  );
  const file = db.prepare(
    `insert into agent_run_files
       (id, agent_run_id, path, change, size_bytes, sha256, kept, reason, content, stored_bytes,
        redactions)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insert = (agentRunId: string, files: SeedFile[], tag: string) =>
    files.forEach((f, i) =>
      file.run(
        `afile_e2e123_cmp_${tag}_${i}`,
        agentRunId,
        f.path,
        f.change,
        f.change === 'deleted' ? null : Buffer.byteLength(f.content ?? 'binary'),
        f.sha,
        f.kept,
        f.reason,
        f.content,
        f.content === null ? 0 : Buffer.byteLength(f.content),
        0,
      ),
    );
  insert(COMPARE_AGENT_RUN.baseline, LEFT_FILES, 'l');
  insert(COMPARE_AGENT_RUN.candidate, RIGHT_FILES, 'r');
  insert(COMPARE_AGENT_RUN.lonely, [LEFT_FILES[4]!], 'x');
}

/** Removes the seeded run; agent runs and their files cascade. */
export function cleanUp(db: DatabaseSync): void {
  const remove = db.prepare('delete from benchmark_runs where id = ?');
  for (const id of [COMPARE_RUN, EMPTY_RUN]) remove.run(id);
}

export function reseed(db: DatabaseSync): void {
  cleanUp(db);
  seed(db);
}
