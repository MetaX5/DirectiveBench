import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

/**
 * Shared helpers for the Playwright tests. The web server and the runner run in the CLI process
 * started by `playwright.config.ts`; tests read (and, for setup only, seed) the same SQLite
 * database in the temporary data directory created there.
 */

export const DEMO_ARTIFACT = 'validate-external-input';
export const DEMO_SUITE = 'Input validation (mock agent demo)';
export const MOCK_LABEL = 'Mock agent: not an AI evaluation';

export function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export function dataDir(): string {
  const dir = process.env.DIRECTIVEBENCH_E2E_DATA_DIR;
  if (!dir) throw new Error('DIRECTIVEBENCH_E2E_DATA_DIR is set by playwright.config.ts');
  return dir;
}

/** The run's temporary root; `playwright.config.ts` removes it when the run ends. */
export function e2eTmpRoot(): string {
  const dir = process.env.DIRECTIVEBENCH_E2E_TMP;
  if (!dir) throw new Error('DIRECTIVEBENCH_E2E_TMP is set by playwright.config.ts');
  return dir;
}

export function databasePath(): string {
  return join(dataDir(), 'directivebench.db');
}

/** Opens the e2e database; the busy timeout covers concurrent writes by the runner. */
export function openDatabase(): DatabaseSync {
  return new DatabaseSync(databasePath(), { timeout: 10_000 });
}

/** Runs `fn` with a database handle that is always closed afterwards. */
export async function withDatabase<T>(fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  const db = openDatabase();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export function count(db: DatabaseSync, sql: string, ...params: string[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** The run persisted by `directivebench demo` (the oldest benchmark run). */
export function demoRunId(db: DatabaseSync): string {
  const row = db.prepare('select id from benchmark_runs order by started_at, id limit 1').get() as
    { id: string } | undefined;
  if (!row) throw new Error('The demo data directory has no benchmark run');
  return row.id;
}

/** The ids needed to build a valid job payload for the demo suite and skill. */
export function demoJobPayload(db: DatabaseSync): {
  suiteVersionId: string;
  artifactVersionId: string;
} {
  const row = db
    .prepare(
      `select sv.id as suiteVersionId, av.id as artifactVersionId
         from benchmark_suite_versions sv, artifact_versions av
         join artifacts a on a.id = av.artifact_id
        where a.name = ?
        order by sv.version desc, av.version desc
        limit 1`,
    )
    .get(DEMO_ARTIFACT) as { suiteVersionId: string; artifactVersionId: string } | undefined;
  if (!row) throw new Error('The demo suite or artifact version is missing');
  return { suiteVersionId: row.suiteVersionId, artifactVersionId: row.artifactVersionId };
}

/**
 * The text lines of the file shown in the "Content of <path>" region, without line numbers and
 * markers (an empty line is drawn as one no-break space to keep its height), and the lines a
 * stored text is shown as (CR LF and CR as LF, no last empty line).
 */
export async function shownFileLines(page: Page, path: string): Promise<string[]> {
  const lines = await page
    .getByRole('region', { name: `Content of ${path}` })
    .locator('pre > span > span:last-child')
    .allTextContents();
  return lines.map((line) => (line === '\u00a0' ? '' : line));
}

export function storedFileLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.replaceAll(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Every kept file of a benchmark run's agent runs, with its stored content. */
export function keptFiles(
  db: DatabaseSync,
  benchmarkRunId: string,
): { agentRunId: string; variant: string; repetition: number; path: string; content: string }[] {
  return db
    .prepare(
      `select a.id as agentRunId, a.variant, a.repetition, f.path, f.content
         from agent_run_files f join agent_runs a on a.id = f.agent_run_id
        where a.benchmark_run_id = ? and f.kept = 'full'
        order by a.case_id, a.variant, a.repetition, f.path`,
    )
    .all(benchmarkRunId) as {
    agentRunId: string;
    variant: string;
    repetition: number;
    path: string;
    content: string;
  }[];
}
