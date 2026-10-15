import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';

test('dashboard shows registry counts and the persisted demo run', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('stat-artifacts')).toHaveText('1');
  await expect(page.getByTestId('stat-skills')).toHaveText('1');
  await expect(page.getByText('Mock agent — not an AI evaluation').first()).toBeVisible();
});

test('artifact list and detail show the imported skill and its evaluation', async ({ page }) => {
  await page.goto('/artifacts');
  const row = page.getByRole('row', { name: /validate-external-input/ });
  await expect(row).toContainText('skill');
  await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'passed');
  await row.getByRole('link', { name: 'validate-external-input' }).click();
  await expect(page.getByTestId('artifact-content')).toContainText(
    'Always validate all external input',
  );
});

test('run detail compares RED and GREEN with recorded assertions', async ({ page }) => {
  await page.goto('/results');
  await page.getByRole('link', { name: 'validate-external-input' }).first().click();
  await expect(page.getByTestId('baseline-score')).toHaveText('50%');
  await expect(page.getByTestId('candidate-score')).toHaveText('100%');
  await expect(page.getByTestId('score-delta')).toHaveText('+50 pts');
  await expect(page.getByTestId('verdict')).toHaveText('improved');
  await expect(page.getByTestId('verdict-reasons')).toContainText('delta +0.5 is at or above 0.05');
  await expect(page.getByTestId('agent-run')).toHaveCount(6);
});

test('benchmark page enqueues a run that the runner completes', async ({ page }) => {
  await page.goto('/benchmarks');
  await page.getByRole('link', { name: 'Input validation (mock agent demo)' }).click();
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page).toHaveURL(/\/executions$/);
  await expect(page.locator('[data-job-status="completed"]')).toHaveCount(2, { timeout: 60_000 });
});

test('planned sections are labelled as not implemented', async ({ page }) => {
  await page.goto('/repositories');
  await expect(page.getByText('Planned — not implemented')).toBeVisible();
});

test('theme toggle switches between light and dark', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const before = (await html.getAttribute('class')) ?? '';
  await page.getByRole('button', { name: 'Toggle colour theme' }).first().click();
  await expect(html).not.toHaveAttribute('class', before);
});

test('enqueueing re-checks execution approval on the server (FR-114-02)', async ({ page }) => {
  const db = new DatabaseSync(
    join(process.env.DIRECTIVEBENCH_E2E_DATA_DIR as string, 'directivebench.db'),
  );
  try {
    await page.goto('/benchmarks');
    await page.getByRole('link', { name: 'Input validation (mock agent demo)' }).click();
    const run = page.getByRole('button', { name: 'Run' });
    await expect(run).toBeEnabled();
    // Approval is revoked after the page was rendered; the server action must refuse the job.
    db.exec('update benchmark_suite_versions set execution_approved_at = null');
    await run.click();
    await expect(page.getByTestId('enqueue-error')).toContainText('not been approved');
    await expect(page.getByRole('button', { name: 'Run' })).toBeDisabled();
  } finally {
    db.exec(
      "update benchmark_suite_versions set execution_approved_at = '2026-01-01T00:00:00.000Z'",
    );
    db.close();
  }
});
