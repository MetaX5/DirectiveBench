import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  DEMO_ARTIFACT,
  dataDir,
  e2eTmpRoot,
  keptFiles,
  shownFileLines,
  storedFileLines,
  withDatabase,
} from './support';

/**
 * SPEC-123 AC-3 and AC-11 through a real capture: `directivebench benchmark run` of the built CLI
 * runs a suite with Claude Code against the e2e data directory, with a fake `claude` on its
 * PATH that writes output files like an agent would. Nothing is seeded: the files reach the
 * database through the engine's capture, redaction and the runner, and the page shows what was
 * stored. `serve` stays mock-only (FR-118-05), so a Claude Code run comes from the CLI, sharing
 * the data directory with the running server as a user's would.
 *
 * - AC-3: every agent run writes `notes.txt` with the API key the CLI passes to `claude` (a
 *   known secret of no token shape, found only by the adapter) and a GitHub token (found by the
 *   core token patterns).
 * - AC-1: every file of every agent run (both cases and variants) reads in full on its page.
 * - AC-16: case `secrets` also writes `deep.ts`, 10,000 lines of 25 nested braces each. The
 *   TypeScript grammar's work grows with the nesting depth on every line: each line stays far under
 *   the per-line time limit, but the file takes about 20 s to tokenize (measured), ten times the
 *   aggregate deadline, on any machine. So the real tokenizer stalls in the worker, the deadline
 *   terminates it, and the page shows plain text with the timeout note, no stand-in needed.
 * - AC-11: case `stalls` asserts a catastrophic pattern on `out.txt`, whose evaluation exceeds
 *   the engine's pattern time limit, so its agent runs end as `assertion-error` after the
 *   capture (A6).
 */

const run = promisify(execFile);

/**
 * `benchmark run` exits 6 (check failed) when the verdict is not `passed`: the `stalls` case makes
 * it `error`. Any other exit code is a failure of the setup.
 */
const CHECK_FAILED_EXIT = 6;

/** A known secret: matches no token pattern, so only the Claude Code adapter's key search finds it. */
const PLANTED_KEY = 'planted-e2e-api-key-K7wQ2mZ9xR4tL8vN';
/** A token-pattern secret (`gh[pousr]_` and at least 20 characters). */
const PLANTED_TOKEN = 'ghp_PlantedE2eToken0123456789abcdefABCDEF';
/** Text on which `(a+)+$` backtracks for minutes: stopped by the pattern time limit. */
const ADVERSARIAL = `${'a'.repeat(32)}!`;
const SUITE_SLUG = 'e2e-real-capture';
/** A real input that keeps the TypeScript grammar busy for about 20 s (260,000 bytes, under 256 KiB). */
const DEEP_TS = `${'{'.repeat(25)}\n`.repeat(10_000);
const TIMEOUT_NOTE = 'Syntax highlighting took too long, so this file is shown as plain text.';
/** `SYNTAX_HIGHLIGHT_DEADLINE_MS` of `apps/web/lib/syntax-highlight.ts`. */
const HIGHLIGHT_DEADLINE_MS = 2_000;
/** Pause between two health requests while the stalled page is pending. */
const HEALTH_POLL_INTERVAL_MS = 100;
/** Four agent runs, two of which wait for the 2 s pattern time limit, on a loaded runner. */
const BENCHMARK_RUN_TIMEOUT_MS = 120_000;

const cliPath = join(import.meta.dirname, '..', '..', 'cli', 'dist', 'cli.js');
/** A recorded API Key Mode stream of Claude Code 2.1.302 (SPEC-203 L3). */
const STREAM = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'agent-adapters',
  'test',
  'fixtures',
  'claude-code',
  '2.1.302',
  'api-key-success.ndjson',
);

let runId = '';
const agentRuns: Record<'secrets' | 'stalls', string> = { secrets: '', stalls: '' };
let suiteRoot = '';

/** Writes the suite and the fake `claude` under the run's temporary root. */
function prepare(): { suite: string; bin: string; home: string } {
  const root = join(e2eTmpRoot(), 'real-capture');
  suiteRoot = join(root, 'suite');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  for (const dir of [join(suiteRoot, 'fixtures', 'example'), bin, home]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(suiteRoot, 'fixtures', 'example', 'README.md'), 'Brief.\n');
  writeFileSync(
    join(suiteRoot, 'benchmark.yaml'),
    [
      'schemaVersion: 1',
      `id: ${SUITE_SLUG}`,
      'name: Real capture (fake claude)',
      'artifactTypes: [skill]',
      'execution: { agent: claude-code, model: null, repetitions: 1, timeoutSeconds: 60 }',
      'cases:',
      '  - id: secrets',
      '    name: Secrets in an output file',
      '    prompt: Write notes.txt and deep.ts',
      '    fixture: { path: fixtures/example }',
      '    assertions:',
      '      - { id: notes, type: file-exists, path: notes.txt }',
      '  - id: stalls',
      '    name: An assertion that cannot finish',
      '    prompt: Write out.txt',
      '    fixture: { path: fixtures/example }',
      '    assertions:',
      "      - { id: pattern, type: file-contains, path: out.txt, pattern: '(a+)+$' }",
      '',
    ].join('\n'),
  );
  // The session start must list the installed skill, or the adapter stops the run as
  // `artifact-not-loaded`; the recorded stream names its own skill `pdf`.
  const deep = join(root, 'deep.ts');
  writeFileSync(deep, DEEP_TS);
  const stream = join(root, 'stream.ndjson');
  writeFileSync(
    stream,
    readFileSync(STREAM, 'utf8').replaceAll('"pdf"', JSON.stringify(DEMO_ARTIFACT)),
  );
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "2.1.302 (Claude Code)"; exit 0 ;;',
      `  --setting-sources) echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0 ;;`,
      'esac',
      'prompt=$(cat)',
      // An agent that copies its credential and a token into a file it writes (AC-3).
      `printf 'api key: %s\\ngithub token: %s\\n' "$ANTHROPIC_API_KEY" '${PLANTED_TOKEN}' > notes.txt`,
      `printf '%s' '${ADVERSARIAL}' > out.txt`,
      `case "$prompt" in *deep.ts*) cp '${deep}' deep.ts ;; esac`,
      `cat '${stream}'`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return { suite: suiteRoot, bin, home };
}

/** Removes the run, its job, the suite (versions and assignment cascade) and its fixture. */
function cleanUp(): Promise<void> {
  return withDatabase((db) => {
    const runs = db
      .prepare(
        `select r.id, r.job_id as jobId from benchmark_runs r
           join benchmark_suite_versions v on v.id = r.suite_version_id
           join benchmark_suites s on s.id = v.suite_id
          where s.slug = ?`,
      )
      .all(SUITE_SLUG) as { id: string; jobId: string | null }[];
    for (const { id, jobId } of runs) {
      db.prepare('delete from benchmark_runs where id = ?').run(id);
      if (jobId !== null) db.prepare('delete from jobs where id = ?').run(jobId);
    }
    db.prepare('delete from benchmark_suites where slug = ?').run(SUITE_SLUG);
    if (suiteRoot !== '') {
      db.prepare('delete from fixture_versions where source_path = ?').run(
        join(suiteRoot, 'fixtures', 'example'),
      );
    }
  });
}

test.beforeAll(async () => {
  test.setTimeout(BENCHMARK_RUN_TIMEOUT_MS);
  const { suite, bin, home } = prepare();
  // The CLI passes only an allowlist on to `claude`; this keeps the developer's PATH, HOME and
  // real `claude` out of the run.
  const env: Record<string, string> = {
    PATH: [bin, '/usr/bin', '/bin'].join(':'),
    HOME: home,
    ANTHROPIC_API_KEY: PLANTED_KEY,
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  };
  const stdout = await run(
    process.execPath,
    [
      cliPath,
      '--data-dir',
      dataDir(),
      'benchmark',
      'run',
      suite,
      '--artifact',
      DEMO_ARTIFACT,
      '--auth',
      'api-key',
      '--yes',
      '--json',
    ],
    {
      // Next.js augments `ProcessEnv` with a required `NODE_ENV`, which the CLI does not need,
      // so the record is widened to the option's type.
      env: env as NodeJS.ProcessEnv,
      timeout: BENCHMARK_RUN_TIMEOUT_MS,
    },
  ).then(
    (done) => done.stdout,
    (error: { code?: unknown; stdout?: string; stderr?: string }) => {
      if (error.code !== CHECK_FAILED_EXIT) throw error;
      return error.stdout ?? '';
    },
  );
  const report = JSON.parse(stdout) as { runId: string; verdict: string };
  expect(report.verdict).toBe('error');
  runId = report.runId;
  await withDatabase((db) => {
    const rows = db
      .prepare(
        `select id, case_id as caseId from agent_runs
          where benchmark_run_id = ? and variant = 'candidate'`,
      )
      .all(runId) as { id: string; caseId: 'secrets' | 'stalls' }[];
    for (const row of rows) agentRuns[row.caseId] = row.id;
  });
});

test.afterAll(cleanUp);

const filesPage = (agentRunId: string, path: string) =>
  `/results/${runId}/agent-runs/${agentRunId}?path=${encodeURIComponent(path)}`;

/** The HTML document and the RSC payload of a URL (the payload Next.js sends on navigation). */
async function bodies(request: APIRequestContext, url: string): Promise<string[]> {
  const html = await request.get(url);
  const rsc = await request.get(url, { headers: { RSC: '1' } });
  expect(html.status()).toBe(200);
  expect(rsc.headers()['content-type']).toContain('text/x-component');
  return [await html.text(), await rsc.text()];
}

test('a secret an agent wrote into a file is stored and shown redacted, with the count (AC-3)', async ({
  page,
  request,
}) => {
  // Stored redacted: no row of the run holds either secret.
  await withDatabase((db) => {
    const files = db
      .prepare(
        `select f.content, f.redactions from agent_run_files f
           join agent_runs a on a.id = f.agent_run_id
          where a.benchmark_run_id = ? and f.path = 'notes.txt'`,
      )
      .all(runId) as { content: string; redactions: number }[];
    expect(files).toHaveLength(4);
    for (const file of files) {
      expect(file).toEqual({
        content: 'api key: [REDACTED]\ngithub token: [REDACTED]\n',
        redactions: 2,
      });
    }
  });

  await page.goto(filesPage(agentRuns.secrets, 'notes.txt'));
  const content = page.getByRole('region', { name: 'Content of notes.txt' });
  await expect(content).toContainText('api key: [REDACTED]');
  await expect(content).toContainText('github token: [REDACTED]');
  await expect(page.getByRole('status')).toContainText('2 secrets redacted.');
  const list = page.getByRole('navigation', { name: 'Changed files' });
  await expect(list.getByRole('listitem').filter({ hasText: 'notes.txt' })).toContainText(
    '2 redacted',
  );

  // Neither secret, nor the distinctive part of either, reaches the files page, the run page or
  // their RSC payloads; the files page carries the redacted content instead.
  const filesBodies = await bodies(request, filesPage(agentRuns.secrets, 'notes.txt'));
  for (const body of filesBodies) expect(body).toContain('github token: [REDACTED]');
  for (const body of [...filesBodies, ...(await bodies(request, `/results/${runId}`))]) {
    for (const secret of [PLANTED_KEY, PLANTED_TOKEN, 'K7wQ2mZ9xR4tL8vN', 'PlantedE2eToken']) {
      expect(body).not.toContain(secret);
    }
  }
});

test('an assertion-error agent run shows the files captured before its assertions (AC-11, A6)', async ({
  page,
}) => {
  await page.goto(`/results/${runId}/agent-runs/${agentRuns.stalls}`);
  await expect(page.getByText('infrastructure-error', { exact: true })).toBeVisible();
  await expect(page.getByTestId('agent-run-files-notice')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Changed files (2)' })).toBeVisible();
  const list = page.getByRole('navigation', { name: 'Changed files' });
  await expect(list.getByRole('listitem')).toHaveCount(2);

  await list.getByRole('link', { name: /out\.txt/ }).click();
  await expect(page.getByRole('region', { name: 'Content of out.txt' })).toContainText(ADVERSARIAL);
  await list.getByRole('link', { name: /notes\.txt/ }).click();
  await expect(page.getByRole('region', { name: 'Content of notes.txt' })).toContainText(
    'github token: [REDACTED]',
  );

  // The run page lists it with its files and the assertion error.
  await withDatabase((db) => {
    const row = db
      .prepare('select error, output_files_kept as kept from agent_runs where id = ?')
      .get(agentRuns.stalls) as { error: string; kept: number };
    expect(row.error).toMatch(/^assertion-error: assertion "pattern" could not be evaluated/);
    expect(row.kept).toBe(1);
  });
  await page.goto(`/results/${runId}`);
  const table = page
    .getByTestId('output-files')
    .getByRole('table', { name: 'Output files of case stalls' });
  const candidate = table.getByRole('row').filter({ hasText: 'Candidate (v1), repetition 1' });
  await expect(candidate).toContainText('infrastructure-error');
  await expect(candidate.getByRole('cell').nth(2)).toHaveText('2');
});

test('every file of every agent run of a fake-claude run is readable in full (AC-1)', async ({
  page,
}) => {
  const files = await withDatabase((db) => keptFiles(db, runId));
  // Two cases, both variants: three files in case `secrets`, two in case `stalls`.
  expect(files).toHaveLength(10);
  for (const file of files) {
    await page.goto(filesPage(file.agentRunId, file.path));
    expect(await shownFileLines(page, file.path)).toEqual(storedFileLines(file.content));
  }
});

test('a file that stalls the tokenizer is shown plain with the timeout note while the server answers (AC-16)', async ({
  page,
  request,
}) => {
  const url = filesPage(agentRuns.secrets, 'deep.ts');
  // The server's own timing, without the browser: the page is answered only after the deadline
  // stopped the worker, which `deep.ts` keeps busy for about 20 s.
  const started = performance.now();
  let answeredAt = Number.POSITIVE_INFINITY;
  const pending = request.get(url).then((response) => {
    answeredAt = performance.now();
    return response;
  });
  // Health requests one after another for as long as the page is pending: each answer is a
  // moment the request thread was free. Tokenizing on that thread would leave one gap of about
  // 20 s; the worker leaves none as long as the deadline.
  const answers: number[] = [];
  while (answeredAt === Number.POSITIVE_INFINITY) {
    const health = await request.get('/api/health');
    expect(health.ok()).toBe(true);
    answers.push(performance.now());
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  const response = await pending;
  expect(response.ok()).toBe(true);
  expect(await response.text()).toContain(TIMEOUT_NOTE);
  // The page waited for the deadline: the stall was real, and the polls cover it.
  expect(answeredAt - started).toBeGreaterThanOrEqual(HIGHLIGHT_DEADLINE_MS);

  const moments = [started, ...answers.filter((at) => at < answeredAt), answeredAt];
  const gaps = moments.slice(1).map((at, index) => at - (moments[index] as number));
  expect(
    Math.max(...gaps),
    `gaps between health answers: ${gaps.map(Math.round).join(', ')}`,
  ).toBeLessThan(HIGHLIGHT_DEADLINE_MS);

  await page.goto(url);
  await expect(page.getByRole('status')).toContainText(TIMEOUT_NOTE);
  const content = page.getByRole('region', { name: 'Content of deep.ts' });
  await expect(content.locator('[data-highlighted]')).toHaveCount(0);
  expect(await shownFileLines(page, 'deep.ts')).toEqual(storedFileLines(DEEP_TS));
});
