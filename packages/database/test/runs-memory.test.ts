import { execFileSync } from 'node:child_process';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listArtifactRuns, listVersionComparisonRuns, type DatabaseHandle } from '../src/index';
import { seedTargets } from './support/fixtures';
import { openTestDatabase, type TestDatabase } from './support/test-database';

/**
 * Codex review of PR #113: ranking and paging runs must not carry their summary JSON through
 * SQLite's sorters. With `temp_store = MEMORY`, a sorter that holds every qualifying summary
 * (2 000 runs × 32 KiB) grows the peak RSS by ~64 MiB (by default it spills the same bytes to
 * temporary files); one that holds only ids and ordering columns stays near zero.
 *
 * The test records the exact statements the repository runs and replays each in a fresh child
 * process, whose peak RSS is not already raised by the test runner. SQLite's own heap limits are
 * not usable: Node's build does not enforce `hard_heap_limit`.
 */

const RUNS = 2_000;
const SEED_BATCH = 50;
const SUMMARY_PAD_BYTES = 16 * 1024; // hex-encoded: 32 KiB of text per summary
/** Far below the ~64 MiB a sorter of summaries costs, far above measurement noise. */
const MAX_PEAK_GROWTH_MIB = 16;

/** Runs one statement in a fresh process and reports how much its peak RSS grew, in MiB. */
const REPLAY = `
const { DatabaseSync } = require('node:sqlite');
const [path, sql, params] = process.argv.slice(1);
const db = new DatabaseSync(path, { readOnly: true });
db.exec('PRAGMA temp_store = MEMORY');
const statement = db.prepare(sql);
const before = process.resourceUsage().maxRSS;
const rows = statement.all(...JSON.parse(params));
const growth = (process.resourceUsage().maxRSS - before) / 1024;
process.stdout.write(JSON.stringify({ rows: rows.length, growth }));
`;

let database: TestDatabase | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  database?.dispose();
});

/** Records the SQL and parameters of every `all` statement run through `handle`. */
function recordStatements(handle: DatabaseHandle): { sql: string; params: SQLInputValue[] }[] {
  const recorded: { sql: string; params: SQLInputValue[] }[] = [];
  const prepare = handle.sqlite.prepare.bind(handle.sqlite);
  vi.spyOn(handle.sqlite, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement);
    statement.all = ((...params: SQLInputValue[]) => {
      recorded.push({ sql, params });
      return all(...params);
    }) as typeof statement.all;
    return statement;
  });
  return recorded;
}

function replay(path: string, statement: { sql: string; params: SQLInputValue[] }) {
  const output = execFileSync(
    process.execPath,
    ['-e', REPLAY, path, statement.sql, JSON.stringify(statement.params)],
    { encoding: 'utf8' },
  );
  return JSON.parse(output) as { rows: number; growth: number };
}

describe('artifact run queries do not sort summaries (Codex review of PR #113)', () => {
  it('ranks and pages runs with bounded memory however large their summaries are', async () => {
    database = await openTestDatabase();
    const { handle } = database;
    const targets = await seedTargets(handle);
    // Seeded inside SQLite, so the summaries never exist as JavaScript strings.
    const insert = handle.sqlite.prepare(
      `with recursive n(i) as (select ? union all select i + 1 from n where i < ? - 1)
       insert into benchmark_runs
         (id, suite_version_id, artifact_version_id, agent_adapter_id, environment, status,
          verdict, comparability_key, summary, warnings, started_at)
       select printf('run_mem_%05d', i), ?, ?, 'mock', '{}', 'completed', 'improved', 'key',
              json_object('candidate', json_object('meanScore', 0.5),
                          'scoring', json_object('minDelta', 0.05),
                          'pad', hex(randomblob(?))),
              '[]', printf('2026-01-01T00:00:%05d', i)
         from n`,
    );
    for (let start = 0; start < RUNS; start += SEED_BATCH) {
      insert.run(
        start,
        start + SEED_BATCH,
        targets.suiteVersionId,
        targets.artifactVersionId,
        SUMMARY_PAD_BYTES,
      );
    }
    handle.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    const recorded = recordStatements(handle);
    const latest = `run_mem_${String(RUNS - 1).padStart(5, '0')}`;
    const comparisons = await listVersionComparisonRuns(handle.db, targets.artifactId);
    expect(comparisons.runs.map((r) => r.runId)).toEqual([latest]);
    const page = await listArtifactRuns(handle.db, targets.artifactId);
    expect(page[0]?.run.id).toBe(latest);
    expect(recorded).toHaveLength(2);

    const [comparisonCost, pageCost] = recorded.map((statement) => replay(handle.path, statement));
    expect(comparisonCost?.rows).toBe(1);
    expect(pageCost?.rows).toBe(200);
    expect(comparisonCost?.growth).toBeLessThan(MAX_PEAK_GROWTH_MIB);
    expect(pageCost?.growth).toBeLessThan(MAX_PEAK_GROWTH_MIB);
  }, 60_000);
});
