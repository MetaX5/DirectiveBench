import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  DEMO_ARTIFACT,
  DEMO_SUITE,
  MOCK_LABEL,
  count,
  dataDir,
  databasePath,
  demoJobPayload,
  demoRunId,
  escapeRegExp,
  openDatabase,
  withDatabase,
} from './support';

/** Enough for the runner to execute the mock benchmark (about 2 s locally) on a slow CI host. */
const JOB_TIMEOUT = 60_000;

function jobRow(page: Page, jobId: string) {
  return page.getByRole('row').filter({ hasText: jobId });
}

async function openDemoBenchmark(page: Page): Promise<void> {
  await page.goto('/benchmarks');
  await page.getByRole('link', { name: DEMO_SUITE }).click();
  await expect(page.getByRole('heading', { level: 1, name: DEMO_SUITE })).toBeVisible();
}

test.describe('artifacts', () => {
  test('artifact list and detail show the imported skill and its evaluation', async ({ page }) => {
    await page.goto('/artifacts');
    const row = page.getByRole('row', { name: new RegExp(DEMO_ARTIFACT) });
    await expect(row).toContainText('skill');
    await expect(row).toContainText('Security');
    await expect(row).toContainText('Code Quality');
    await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'passed');
    // The latest score comes from the mock agent, so it carries the mock label (FR-101-14).
    const score = row.getByTestId('latest-score');
    await expect(score).toContainText('100%');
    await expect(score.getByText(MOCK_LABEL)).toBeVisible();
    await row.getByRole('link', { name: DEMO_ARTIFACT }).click();

    await expect(page).toHaveURL(/\/artifacts\/[\w-]+$/);
    await expect(page.getByRole('heading', { level: 1, name: DEMO_ARTIFACT })).toBeVisible();
    await expect(page.getByText(MOCK_LABEL).first()).toBeVisible();
    await expect(page.getByTestId('occurrences')).toContainText('Bundled examples');

    const sections = page.getByRole('navigation', { name: 'Artifact sections' });
    await sections.getByRole('link', { name: 'Content' }).click();
    await expect(page).toHaveURL(/\?tab=content$/);
    await expect(page.getByTestId('artifact-raw')).toContainText(
      'Always validate all external input',
    );
    await sections.getByRole('link', { name: 'Versions' }).click();
    await expect(page.getByRole('row', { name: /^v1 / })).toBeVisible();
    await sections.getByRole('link', { name: 'Benchmarks' }).click();
    await expect(page.getByRole('link', { name: DEMO_SUITE })).toHaveAttribute(
      'href',
      /^\/benchmarks\//,
    );
    await sections.getByRole('link', { name: 'Results by version' }).click();
    await expect(page.getByText(MOCK_LABEL).first()).toBeVisible();

    await sections.getByRole('link', { name: 'Overview' }).click();
    await page.getByRole('link', { name: 'Open run details and traces' }).click();
    await expect(page).toHaveURL(/\/results\/run_[\w-]+$/);
    await expect(page.getByTestId('verdict')).toHaveText('improved');
  });

  test('artifact filters narrow the list by text, type and category', async ({ page }) => {
    await page.goto('/artifacts?type=skill&category=security');
    await expect(page.getByRole('link', { name: DEMO_ARTIFACT })).toBeVisible();

    await page.goto('/artifacts?type=rule');
    await expect(page.getByText('No artifacts match the filters')).toBeVisible();

    await page.goto('/artifacts');
    await page.getByRole('textbox', { name: 'Search' }).fill('zzz');
    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page).toHaveURL(/[?&]q=zzz/);
    await expect(page.getByText('No artifacts match the filters')).toBeVisible();
  });
});

test.describe('results', () => {
  test('result list and run detail compare RED and GREEN with recorded assertions', async ({
    page,
  }) => {
    const runId = await withDatabase(demoRunId);
    await page.goto('/results');
    const row = page.getByRole('row').filter({ has: page.locator(`a[href="/results/${runId}"]`) });
    await expect(row).toContainText(DEMO_SUITE);
    await expect(row).toContainText(MOCK_LABEL);
    await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'passed');
    await row.getByRole('link', { name: DEMO_ARTIFACT }).click();

    await expect(page).toHaveURL(new RegExp(`/results/${runId}$`));
    await expect(page.getByTestId('baseline-score')).toHaveText('50%');
    await expect(page.getByTestId('candidate-score')).toHaveText('100%');
    await expect(page.getByTestId('score-delta')).toHaveText('+50 pts');
    await expect(page.getByTestId('verdict')).toHaveText('improved');
    await expect(page.getByTestId('verdict-reasons')).toContainText(
      'delta +0.5 is at or above 0.05',
    );
    await expect(page.getByTestId('agent-run')).toHaveCount(6);
    await expect(page.getByText(MOCK_LABEL).first()).toBeVisible();
    await expect(page.getByText('Not sandboxed').first()).toBeVisible();

    // Every agent run expands to its recorded assertion results.
    const firstRun = page.getByTestId('agent-run').first();
    await firstRun.locator('summary').first().click();
    await expect(firstRun.getByRole('table')).toBeVisible();
    await expect(firstRun.getByText(/^(pass|fail)$/).first()).toBeVisible();
  });
});

test.describe('benchmarks and executions', () => {
  test('benchmark Run enqueues a job that the runner completes, linked to its result', async ({
    page,
  }) => {
    const before = await withDatabase((db) => ({
      jobIds: new Set(
        (db.prepare('select id from jobs').all() as { id: string }[]).map((job) => job.id),
      ),
      completed: count(db, "select count(*) as n from jobs where status = 'completed'"),
    }));

    await page.goto('/benchmarks');
    const suiteRow = page.getByRole('row', { name: new RegExp(escapeRegExp(DEMO_SUITE)) });
    await expect(suiteRow).toContainText('mock');
    await suiteRow.getByRole('link', { name: DEMO_SUITE }).click();
    await expect(page.getByRole('heading', { level: 1, name: DEMO_SUITE })).toBeVisible();
    await expect(page.getByText(MOCK_LABEL).first()).toBeVisible();
    await expect(page.getByText('Not sandboxed').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cases' })).toBeVisible();

    await page.getByRole('button', { name: 'Run' }).click();
    await expect(page).toHaveURL(/\/executions$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Executions' })).toBeVisible();

    const newJobs = await withDatabase((db) =>
      (db.prepare('select id from jobs').all() as { id: string }[])
        .map((job) => job.id)
        .filter((id) => !before.jobIds.has(id)),
    );
    expect(newJobs).toHaveLength(1);
    const jobId = newJobs[0] as string;
    const row = jobRow(page, jobId);
    await expect(row).toContainText(DEMO_SUITE);
    await expect(row).toContainText(DEMO_ARTIFACT);
    // The page refreshes itself while a job is active; no reload is needed.
    await expect(row).toHaveAttribute('data-job-status', 'completed', { timeout: JOB_TIMEOUT });
    await expect(page.locator('[data-job-status="completed"]')).toHaveCount(before.completed + 1);
    await expect(row.getByRole('button', { name: 'Cancel' })).toHaveCount(0);

    await row.getByRole('link', { name: 'View run' }).click();
    await expect(page).toHaveURL(/\/results\/run_[\w-]+$/);
    const runId = new URL(page.url()).pathname.split('/').pop() as string;
    await expect(page.getByRole('heading', { level: 1 })).toContainText(DEMO_ARTIFACT);
    await expect(page.getByTestId('verdict')).toHaveText('improved');
    await expect(page.getByTestId('baseline-score')).toHaveText('50%');
    await expect(page.getByTestId('candidate-score')).toHaveText('100%');
    await expect(page.getByTestId('agent-run')).toHaveCount(6);
    await expect(page.getByText(MOCK_LABEL).first()).toBeVisible();

    // The new run is listed on its benchmark page and in Results.
    await page
      .getByRole('link', { name: new RegExp(`^${escapeRegExp(DEMO_SUITE)} v\\d+$`) })
      .click();
    await expect(page.getByRole('link', { name: runId })).toBeVisible();
    await page.goto('/results');
    await expect(page.locator(`a[href="/results/${runId}"]`)).toBeVisible();
  });

  test('enqueueing re-checks execution approval on the server (FR-114-02)', async ({ page }) => {
    const db = openDatabase();
    const original = db
      .prepare('select id, execution_approved_at as approvedAt from benchmark_suite_versions')
      .all() as { id: string; approvedAt: string | null }[];
    try {
      await openDemoBenchmark(page);
      const run = page.getByRole('button', { name: 'Run' });
      await expect(run).toBeEnabled();
      // Approval is revoked after the page was rendered; the server action must refuse the job.
      db.exec('update benchmark_suite_versions set execution_approved_at = null');
      const jobsBefore = count(db, 'select count(*) as n from jobs');
      await run.click();
      await expect(page.getByTestId('enqueue-error')).toContainText('not been approved');
      await expect(page.getByRole('button', { name: 'Run' })).toBeDisabled();
      expect(count(db, 'select count(*) as n from jobs')).toBe(jobsBefore);
    } finally {
      const restore = db.prepare(
        'update benchmark_suite_versions set execution_approved_at = ? where id = ?',
      );
      for (const { id, approvedAt } of original) restore.run(approvedAt, id);
      db.close();
    }
  });

  test('a suite with a non-mock agent is never enqueued from the UI and shows the CLI command (SPEC-118 FR-118-05/53)', async ({
    page,
  }) => {
    const db = openDatabase();
    const original = db.prepare('select id, definition from benchmark_suite_versions').all() as {
      id: string;
      definition: string;
    }[];
    try {
      await openDemoBenchmark(page);
      const run = page.getByRole('button', { name: 'Run' });
      await expect(run).toBeEnabled();
      // The suite switches to a real agent after the page was rendered: the server action
      // itself must refuse it, not only the page.
      db.exec(
        `update benchmark_suite_versions
            set definition = json_set(definition, '$.execution.agent', 'claude-code')`,
      );
      const jobsBefore = count(db, 'select count(*) as n from jobs');
      await run.click();
      await expect(page.getByTestId('enqueue-error')).toContainText(
        'This suite uses agent "claude-code". The web UI runs only mock-agent suites',
      );
      expect(count(db, 'select count(*) as n from jobs')).toBe(jobsBefore);

      // Re-rendered for the real agent: no Run button, the CLI command instead.
      const cli = page.getByTestId('run-from-cli');
      await expect(cli.getByRole('heading', { name: 'Run from the CLI' })).toBeVisible();
      await expect(cli).not.toContainText('Planned');
      await expect(cli).toContainText(
        `directivebench benchmark run <suite-folder> --artifact ${DEMO_ARTIFACT}`,
      );
      await expect(page.getByRole('button', { name: 'Run' })).toHaveCount(0);
      await expect(page.getByText(MOCK_LABEL)).toHaveCount(0);
    } finally {
      const restore = db.prepare('update benchmark_suite_versions set definition = ? where id = ?');
      for (const { id, definition } of original) restore.run(definition, id);
      db.close();
    }
  });

  /*
   * Cancellation needs a job that stays `pending` or `running` until the test clicks Cancel. The
   * runner in the served CLI polls every second and finishes the mock benchmark in ~2 s, so a
   * job enqueued through the UI would race the click. Instead the tests seed the job directly in
   * the temporary database:
   *
   * - pending: a temporary SQLite trigger ignores the runner's `pending → running` claim for
   *   that one job id (RAISE(IGNORE) makes the atomic UPDATE … RETURNING claim return no row),
   *   so it stays pending however often the runner polls. Cancelling is a different status
   *   transition and is not affected, so the real server action and repository code run.
   * - running: a job owned by another runner id with a fresh heartbeat. The served runner only
   *   claims pending jobs and recovers stale ones only at start-up, so it never touches it; the
   *   test verifies the cancellation request and then plays the owning runner by recording
   *   `cancelled`, which the auto-refreshing page must pick up.
   */
  test('cancelling a pending job from Executions cancels it immediately', async ({ page }) => {
    const jobId = `job_e2eHeldPending${Date.now()}`;
    const db = openDatabase();
    try {
      db.exec(
        `create trigger e2e_hold_pending_job before update of status on jobs
           when old.id = '${jobId}' and new.status = 'running'
           begin select raise(ignore); end`,
      );
      db.prepare(
        `insert into jobs (id, type, status, payload, attempts, created_at)
         values (?, 'benchmark-run', 'pending', ?, 0, ?)`,
      ).run(jobId, JSON.stringify(demoJobPayload(db)), new Date().toISOString());

      await page.goto('/executions');
      const row = jobRow(page, jobId);
      await expect(row).toHaveAttribute('data-job-status', 'pending');
      await expect(row).toContainText(DEMO_SUITE);
      await expect(row).toContainText(DEMO_ARTIFACT);
      await row.getByRole('button', { name: 'Cancel' }).click();

      await expect(row).toHaveAttribute('data-job-status', 'cancelled');
      await expect(row.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      const job = db
        .prepare('select status, cancel_requested_at, finished_at, attempts from jobs where id = ?')
        .get(jobId) as Record<string, unknown>;
      expect(job.status).toBe('cancelled');
      expect(job.cancel_requested_at).toEqual(expect.any(String));
      expect(job.finished_at).toEqual(expect.any(String));
      expect(job.attempts).toBe(0); // the runner never started it
    } finally {
      db.prepare(
        "update jobs set status = 'cancelled', finished_at = ? where id = ? and status = 'pending'",
      ).run(new Date().toISOString(), jobId);
      db.exec('drop trigger if exists e2e_hold_pending_job');
      db.close();
    }
  });

  test('cancelling a running job from Executions requests cancellation from its runner', async ({
    page,
  }) => {
    const jobId = `job_e2eForeignRunning${Date.now()}`;
    const db = openDatabase();
    try {
      const now = new Date().toISOString();
      db.prepare(
        `insert into jobs (id, type, status, payload, runner_id, attempts, created_at, started_at, heartbeat_at)
         values (?, 'benchmark-run', 'running', ?, 'e2e-foreign-runner', 1, ?, ?, ?)`,
      ).run(jobId, JSON.stringify(demoJobPayload(db)), now, now, now);

      await page.goto('/executions');
      const row = jobRow(page, jobId);
      await expect(row).toHaveAttribute('data-job-status', 'running');
      await row.getByRole('button', { name: 'Cancel' }).click();

      // A running job is only flagged; its runner observes the flag and stops the job.
      await expect(row).toContainText('cancelling…');
      await expect(row.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      await expect(row).toHaveAttribute('data-job-status', 'running');
      const job = db
        .prepare('select status, cancel_requested_at from jobs where id = ?')
        .get(jobId) as Record<string, unknown>;
      expect(job.status).toBe('running');
      expect(job.cancel_requested_at).toEqual(expect.any(String));

      // Play the owning runner: record the final status; the page refreshes while jobs are active.
      db.prepare("update jobs set status = 'cancelled', finished_at = ? where id = ?").run(
        new Date().toISOString(),
        jobId,
      );
      await expect(row).toHaveAttribute('data-job-status', 'cancelled', { timeout: 10_000 });
      await expect(row).not.toContainText('cancelling…');
    } finally {
      db.prepare(
        "update jobs set status = 'cancelled', finished_at = ? where id = ? and status = 'running'",
      ).run(new Date().toISOString(), jobId);
      db.close();
    }
  });
});

test.describe('catalog and configuration', () => {
  test('categories list the predefined categories with artifact counts', async ({ page }) => {
    const categories = await withDatabase((db) =>
      count(db, 'select count(*) as n from categories'),
    );
    await page.goto('/categories');
    await expect(page.getByRole('heading', { level: 1, name: 'Categories' })).toBeVisible();
    await expect(page.getByText(/Read-only in this release/)).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(categories + 1); // + header row

    const python = page.getByRole('row', { name: /^Python / });
    await expect(python).toContainText('Predefined');
    await expect(python.getByRole('cell').last()).toHaveText('0');
    await expect(python.getByRole('link')).toHaveCount(0);

    const security = page.getByRole('row', { name: /^Security / });
    await expect(security).toContainText('security');
    await expect(security.getByRole('cell').last()).toHaveText('1');
    await security.getByRole('link', { name: 'Security' }).click();
    await expect(page).toHaveURL(/\/artifacts\?category=security$/);
    await expect(page.getByRole('link', { name: DEMO_ARTIFACT })).toBeVisible();
  });

  test('agent connections show the built-in mock agent, labelled as not AI', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByRole('heading', { level: 1, name: 'Agent Connections' })).toBeVisible();
    const mock = page.getByRole('row', { name: /Mock Agent/ });
    await expect(mock).toContainText('Mock Agent (deterministic, no AI)');
    await expect(mock).toContainText('built-in');
    await expect(mock).toContainText('1.0.0');
    await expect(mock).toContainText('not required');
    await expect(mock).toContainText('supported');

    // Real CLI agents are detected on PATH (machine dependent); execution is not implemented.
    const cliAgents = page.locator('tr[data-agent]');
    await expect(cliAgents).not.toHaveCount(0);
    for (const agent of await cliAgents.all()) {
      await expect(agent).toContainText(/found|not found/);
      await expect(agent).toContainText('not implemented');
      await expect(agent).toContainText(/\.ai\/specs\/.+\.md/);
    }
  });

  test('Claude Code readiness is shown per auth mode', async ({ page }) => {
    // playwright.config.ts puts a fake, logged-in `claude` first on the server's PATH and clears
    // ANTHROPIC_API_KEY, so this row is the same on every machine.
    await page.goto('/agents');
    const claude = page.locator('tr[data-agent="claude-code"]');
    await expect(claude).toContainText('found');
    await expect(claude).toContainText('2.1.302 (Claude Code)');
    await expect(claude.getByText('ready', { exact: true })).toBeVisible();
    await expect(claude.locator('[data-auth-mode="subscription"]')).toHaveText(
      'Subscription: ready — Logged in (claude.ai).',
    );
    await expect(claude.locator('[data-auth-mode="api-key"]')).toHaveText(
      "API key: not ready (auth-missing) — ANTHROPIC_API_KEY is not set (or empty) in this process's environment.",
    );
    // Execution stays unavailable until the adapter is wired into `benchmark run` (E06-S04).
    await expect(claude).toContainText('not implemented');
    // Readiness of the other agents is not implemented.
    for (const id of ['codex', 'cursor']) {
      await expect(page.locator(`tr[data-agent="${id}"]`)).toContainText('unknown');
    }
  });

  test('settings show the data directory and the effective configuration', async ({ page }) => {
    const config: unknown = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8'));
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Planned — not implemented: settings editor')).toBeVisible();
    await expect(page.getByText(dataDir(), { exact: true })).toBeVisible();
    await expect(page.getByText(`database: ${databasePath()}`)).toBeVisible();

    const effective = page.getByRole('main').locator('pre');
    await expect(effective).toHaveCount(1);
    expect(JSON.parse((await effective.textContent()) ?? '')).toEqual(config);

    await expect(
      page.getByText('.ai/specs/2026-10-14-settings-and-configuration.md'),
    ).toBeVisible();
    for (const item of ['Settings editor', 'Secret storage (OS keychain)', 'Backup and restore']) {
      await expect(page.getByText(`${item} — not implemented`)).toBeVisible();
    }
  });
});
