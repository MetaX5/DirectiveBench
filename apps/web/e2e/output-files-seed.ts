import type { DatabaseSync } from 'node:sqlite';

/**
 * Seeded output files for the run page card and the agent-run files page (SPEC-123 FR-123-20,
 * FR-123-21, D21 to D34). It adds two mock-agent benchmark runs to the demo database: one with
 * every file state (truncated by either limit, binary, deleted, artifact, not kept, empty,
 * redacted, CR line endings, hostile markup) and every agent-run state (files, no file changed,
 * not kept with a reason, stored before capture), and one whose agent runs all predate capture.
 * Kept free of relative imports so it can also seed a manual check.
 */

export const FILES_RUN = 'run_e2e123_files';
export const OLD_RUN = 'run_e2e123_old';
/** A run whose one agent run wrote code in listed languages (Phase 3a, syntax highlighting). */
export const CODE_RUN = 'run_e2e123_code';
export const AGENT_RUN = {
  rich: 'arun_e2e123_rich',
  none: 'arun_e2e123_none',
  reason: 'arun_e2e123_reason',
  old: 'arun_e2e123_old',
  oldOnly: 'arun_e2e123_oldonly',
  code: 'arun_e2e123_code',
};
export const CASE_ID = 'edit-files';
export const TIMEOUT_REASON = 'the agent did not stop after its timeout';

/** Agent-written markup that must render as text, never run (SPEC-123 §12, AC-15). */
export const HOSTILE_LINES = [
  '<script>window.__hostile = 1</script>',
  '<img src=x onerror="window.__hostile = 2">',
  'API key: [REDACTED]',
];

interface SeedFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  sizeBytes: number | null;
  kept: 'full' | 'truncated' | 'none';
  reason: 'file-limit' | 'run-limit' | 'binary' | 'deleted' | 'artifact-path' | null;
  content: string | null;
  redactions: number;
}

/** The rich agent run's files, in the path order the page lists them. */
export const FILES: SeedFile[] = [
  {
    path: 'a/hostile.html',
    change: 'added',
    sizeBytes: 120,
    kept: 'full',
    reason: null,
    content: `${HOSTILE_LINES.join('\r\n')}\n`,
    redactions: 1,
  },
  {
    path: 'big.log',
    change: 'modified',
    sizeBytes: 2_000_000,
    kept: 'truncated',
    reason: 'file-limit',
    content: 'first line\nsecond line\n',
    redactions: 0,
  },
  {
    path: 'empty.txt',
    change: 'added',
    sizeBytes: 0,
    kept: 'full',
    reason: null,
    content: '',
    redactions: 0,
  },
  {
    path: 'img.png',
    change: 'added',
    sizeBytes: 2048,
    kept: 'none',
    reason: 'binary',
    content: null,
    redactions: 0,
  },
  {
    path: 'old.txt',
    change: 'deleted',
    sizeBytes: null,
    kept: 'none',
    reason: 'deleted',
    content: null,
    redactions: 0,
  },
  {
    path: 'run-cut.txt',
    change: 'added',
    sizeBytes: 900_000,
    kept: 'truncated',
    reason: 'run-limit',
    content: 'kept part\n',
    redactions: 0,
  },
  {
    path: 'skill/SKILL.md',
    change: 'added',
    sizeBytes: 300,
    kept: 'none',
    reason: 'artifact-path',
    content: null,
    redactions: 0,
  },
  {
    path: 'zz-not-kept.txt',
    change: 'added',
    sizeBytes: 500_000,
    kept: 'none',
    reason: 'run-limit',
    content: null,
    redactions: 0,
  },
];

/**
 * The code agent run's files, in path order (SPEC-123 §6.7). Together they produce every
 * `--syntax-token-*` colour (AC-14); `build/bundle.ts` is one byte over the highlighting bound
 * (AC-13) and `notes.txt` has no listed extension.
 */
export const CODE_FILES: Record<string, string> = {
  'README.md':
    '# Notes\n\nSee [the docs](https://example.com/docs).\n\n```sh\nnpm run build\n```\n',
  'build/bundle.ts': `const a = 1;\n${'x'.repeat(262_145 - 'const a = 1;\n'.length)}`,
  'notes.txt': 'const a = 1; // not highlighted\n',
  'src/add.ts':
    '/** Adds two numbers. */\nexport function add(a: number, b: number): string {\n  const total = a + b; // sum\n  return `${total} items`.replace(\'x\', "y");\n}\n',
  'src/fmt.py': 'def fmt(x: int) -> str:\n    """Doc."""\n    return f"{x}"  # c\n',
};

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
  for (const id of [FILES_RUN, OLD_RUN, CODE_RUN]) {
    run.run(id, ids.suiteVersionId, ids.artifactVersionId, now, now);
  }
  const agentRun = db.prepare(
    `insert into agent_runs
       (id, benchmark_run_id, case_id, variant, repetition, fixture_version_id, execution_status,
        score, passed, duration_ms, changed_files, trace, usage, error, created_at,
        output_files_kept, output_files_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, ?, '[]', null, null, ?, ?, ?)`,
  );
  const changed = (n: number) =>
    JSON.stringify(Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, change: 'added' })));
  agentRun.run(
    AGENT_RUN.rich,
    FILES_RUN,
    CASE_ID,
    'baseline',
    1,
    fixture,
    'completed',
    0,
    0,
    JSON.stringify(FILES.map((f) => ({ path: f.path, change: f.change }))),
    now,
    1,
    null,
  );
  agentRun.run(
    AGENT_RUN.none,
    FILES_RUN,
    CASE_ID,
    'candidate',
    1,
    fixture,
    'completed',
    1,
    1,
    '[]',
    now,
    1,
    null,
  );
  agentRun.run(
    AGENT_RUN.reason,
    FILES_RUN,
    CASE_ID,
    'baseline',
    2,
    fixture,
    'timeout',
    null,
    null,
    changed(3),
    now,
    0,
    TIMEOUT_REASON,
  );
  agentRun.run(
    AGENT_RUN.old,
    FILES_RUN,
    CASE_ID,
    'candidate',
    2,
    fixture,
    'completed',
    1,
    1,
    changed(2),
    now,
    0,
    null,
  );
  agentRun.run(
    AGENT_RUN.oldOnly,
    OLD_RUN,
    CASE_ID,
    'baseline',
    1,
    fixture,
    'completed',
    1,
    1,
    changed(1),
    now,
    0,
    null,
  );
  agentRun.run(
    AGENT_RUN.code,
    CODE_RUN,
    CASE_ID,
    'candidate',
    1,
    fixture,
    'completed',
    1,
    1,
    JSON.stringify(Object.keys(CODE_FILES).map((path) => ({ path, change: 'added' }))),
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
  FILES.forEach((f, i) =>
    file.run(
      `afile_e2e123_${i}`,
      AGENT_RUN.rich,
      f.path,
      f.change,
      f.sizeBytes,
      f.change === 'deleted' ? null : 'a'.repeat(64),
      f.kept,
      f.reason,
      f.content,
      f.content === null ? 0 : Buffer.byteLength(f.content),
      f.redactions,
    ),
  );
  Object.entries(CODE_FILES).forEach(([path, content], i) => {
    const bytes = Buffer.byteLength(content);
    file.run(
      `afile_e2e123_code_${i}`,
      AGENT_RUN.code,
      path,
      'added',
      bytes,
      'a'.repeat(64),
      'full',
      null,
      content,
      bytes,
      0,
    );
  });
}

/** Removes the seeded runs; agent runs and their files cascade. */
export function cleanUp(db: DatabaseSync): void {
  const remove = db.prepare('delete from benchmark_runs where id = ?');
  for (const id of [FILES_RUN, OLD_RUN, CODE_RUN]) remove.run(id);
}

export function reseed(db: DatabaseSync): void {
  cleanUp(db);
  seed(db);
}
