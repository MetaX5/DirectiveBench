import type { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';
import { scanTextContrast } from './contrast';
import { cleanUp, reseed, RUN } from './results-seed';
import { withDatabase } from './support';

/**
 * Issue 280 (SPEC-203 §4.1, ADR-0015): the run page shows the reserved-name check of an A/B run
 * in "Environment and versions", only for a run that had it. Seeded runs only, removed after.
 */

const PASSED =
  'Passed: 1 extra session without the skill (not scored), 1.0 s, 7,104 tokens';
const STOPPED =
  'Stopped the run (skill-name-reserved): 1 extra session without the skill (not scored), 910 ms';

function storeCheck(db: DatabaseSync, overrides: Record<string, unknown>): void {
  const check = {
    status: 'completed',
    errorCode: null,
    error: null,
    durationMs: 1040,
    usage: { inputTokens: 7100, outputTokens: 4 },
    adapterVersion: '2.1.325 (Claude Code)',
    executionModel: 'claude-haiku-5-5',
    ...overrides,
  };
  db.prepare('update benchmark_runs set environment = ? where id = ?').run(
    JSON.stringify({ kind: 'local-process', reservedNameCheck: check }),
    RUN.v2Ab,
  );
}

async function noHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test.beforeAll(() => withDatabase(reseed));
test.afterAll(() => withDatabase(cleanUp));

test('an A/B run shows its reserved-name check; a none run shows none', async ({ page }) => {
  await withDatabase((db) => storeCheck(db, {}));
  await page.goto(`/results/${RUN.v2Ab}`);
  await expect(page.getByTestId('reserved-name-check')).toHaveText(PASSED);
  await expect(page.getByText('Reserved-name check', { exact: true })).toBeVisible();

  await page.goto(`/results/${RUN.v1None}`);
  await expect(page.getByRole('heading', { name: 'Environment and versions' })).toBeVisible();
  await expect(page.getByTestId('reserved-name-check')).toHaveCount(0);
  await expect(page.getByText('Reserved-name check', { exact: true })).toHaveCount(0);

  await withDatabase((db) =>
    storeCheck(db, {
      status: 'infrastructure-error',
      errorCode: 'skill-name-reserved',
      durationMs: 910,
      usage: null,
    }),
  );
  await page.goto(`/results/${RUN.v2Ab}`);
  await expect(page.getByTestId('reserved-name-check')).toHaveText(STOPPED);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the reserved-name check fact has AA contrast and fits 320px in ${theme}`, async ({
    page,
  }) => {
    await withDatabase((db) => storeCheck(db, {}));
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/results/${RUN.v2Ab}`);
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      await expect(page.getByTestId('reserved-name-check')).toHaveText(PASSED);
      await page.evaluate(() => document.fonts.ready);
      await noHorizontalScroll(page);
      const failures = (await scanTextContrast(page)).filter((r) => r.ratio < r.threshold);
      expect.soft(failures, `${theme} ${width}`).toEqual([]);
    }
  });
}
