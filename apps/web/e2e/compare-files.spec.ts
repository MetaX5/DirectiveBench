import { expect, test, type Page } from '@playwright/test';
import {
  COMPARE_AGENT_RUN,
  COMPARE_CASE,
  COMPARE_RUN,
  EMPTY_RUN,
  HOSTILE_LINE,
  LEFT_FILES,
  LONELY_CASE,
  NOT_KEPT_REASON,
  cleanUp,
  reseed,
} from './compare-seed';
import { scanTextContrast } from './contrast';
import { MOCK_LABEL, demoRunId, escapeRegExp, withDatabase } from './support';

/**
 * SPEC-123 Phase 4: the compare page (FR-123-30 to FR-123-32, decisions D36 to D45), on the
 * demo run and on seeded rows that cover identical, differing, one-side, deleted, binary,
 * too-large and not-kept sides.
 */

const comparePage = (runId: string, query: Record<string, string> = {}) => {
  const params = new URLSearchParams(query).toString();
  return `/results/${runId}/compare${params ? `?${params}` : ''}`;
};
const seeded = (query: Record<string, string> = {}) =>
  comparePage(COMPARE_RUN, { case: COMPARE_CASE, ...query });

const pathList = (page: Page) => page.getByRole('navigation', { name: 'Changed paths' });
const pathLink = (page: Page, path: string) =>
  pathList(page).getByRole('link', { name: new RegExp(`^${escapeRegExp(path)}`) });

async function noHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test.beforeAll(async () => withDatabase(reseed));
test.afterAll(async () => withDatabase(cleanUp));

test('the run page links each case to the compare page with its default runs (D36, FR-123-30)', async ({
  page,
}) => {
  const runId = await withDatabase(demoRunId);
  await page.goto(`/results/${runId}`);
  await page
    .getByTestId('output-files')
    .getByRole('link', { name: 'Compare agent runs of case implement-parse-age' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/results/${runId}/compare\\?case=implement-parse-age$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Compare output files' })).toBeVisible();
  await expect(page.getByText(MOCK_LABEL)).toBeVisible();
  // Defaults: baseline repetition 1 left, candidate repetition 1 right, first path.
  const left = page.locator('select[name="left"] option:checked');
  const right = page.locator('select[name="right"] option:checked');
  await expect(left).toHaveText('Baseline (no artifact), repetition 1 (failed)');
  await expect(right).toHaveText('Candidate (v1), repetition 1 (passed)');
  await expect(pathLink(page, 'src/parse-age.js')).toHaveAttribute('aria-current', 'page');
  await expect(pathLink(page, 'src/parse-age.js')).toContainText('Differs');
  await expect(
    page.getByRole('heading', { level: 4, name: 'Left: Baseline (no artifact), repetition 1' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Right: src/parse-age.js' })).toContainText(
    'export function parseAge',
  );
  // FR-123-32: changed lines carry a text marker for assistive technology, not only a colour.
  await expect(page.getByText('Added:').first()).toBeAttached();
  await page.getByRole('link', { name: 'Back to the run' }).click();
  await expect(page).toHaveURL(new RegExp(`/results/${runId}$`));
});

test('the path list is the union with only-left, only-right, identical and differs (FR-123-30, D43)', async ({
  page,
}) => {
  await page.goto(seeded());
  await expect(page.getByRole('heading', { name: 'Changed paths (7)' })).toBeVisible();
  const items = pathList(page).getByRole('listitem');
  const expected: [string, string][] = [
    ['deleted.txt', 'Identical'],
    ['huge.txt', 'Differs'],
    ['only-left.txt', 'Only left'],
    ['only-right.md', 'Only right'],
    ['pic.png', 'Differs'],
    ['same.js', 'Identical'],
    ['src/render.php', 'Differs'],
  ];
  await expect(items).toHaveCount(expected.length);
  for (const [i, [path, badge]] of expected.entries()) {
    await expect(items.nth(i)).toContainText(path);
    await expect(items.nth(i)).toContainText(badge);
  }
  // A one-side path keeps that side's badges after "Only left" (D43).
  await expect(items.nth(2)).toContainText('Only leftAdded');
  // Default path: the first of the union.
  await expect(pathLink(page, 'deleted.txt')).toHaveAttribute('aria-current', 'page');
});

test('each pair shows its diff summary and side notices (FR-123-31, §14, D4, D15, D16)', async ({
  page,
}) => {
  const cases: [string, string, string[]][] = [
    ['src/render.php', '1 line removed, 2 lines added.', []],
    ['same.js', 'The files are identical.', []],
    [
      'huge.txt',
      'These files differ in more than 1,000 lines, so they are shown without alignment.',
      [],
    ],
    [
      'only-left.txt',
      'No line comparison: one side has no text to compare.',
      ['Not present in this agent run.'],
    ],
    ['pic.png', 'No line comparison: one side has no text to compare.', ['Binary file, not kept.']],
    // Browser QA finding 2: both sides deleted it, so neither has text.
    [
      'deleted.txt',
      'No line comparison: neither side has text to compare.',
      ['Deleted by the agent.'],
    ],
  ];
  for (const [path, sentence, notices] of cases) {
    await page.goto(seeded());
    await pathLink(page, path).click();
    await expect(page).toHaveURL(
      new RegExp(`path=${escapeRegExp(encodeURIComponent(path))}#diff$`),
    );
    await expect(pathLink(page, path)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 3, name: path })).toBeVisible();
    await expect(page.getByText(sentence, { exact: true })).toBeVisible();
    for (const notice of notices) await expect(page.getByText(notice).first()).toBeVisible();
  }
  // FR-123-32: removed and added lines are named, not only coloured.
  await page.goto(seeded({ path: 'src/render.php' }));
  const left = page.getByRole('region', { name: 'Left: src/render.php' });
  const right = page.getByRole('region', { name: 'Right: src/render.php' });
  await expect(left).toContainText('Removed:');
  await expect(right).toContainText('Added:');
});

test('agent-written markup in a diff is text, never run (SPEC-123 §12)', async ({ page }) => {
  await page.goto(seeded({ path: 'only-right.md' }));
  const right = page.getByRole('region', { name: 'Right: only-right.md' });
  await expect(right).toContainText(HOSTILE_LINE);
  await expect(right.locator('img, script')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as { __hostileCompare?: number }).__hostileCompare),
  ).toBeUndefined();
});

test('choosing other runs keeps the path, and says so when neither run has it (D37, D38, D41)', async ({
  page,
}) => {
  await page.goto(seeded({ path: 'src/render.php' }));
  // The selects list the case's runs, baseline first (D39).
  await expect(page.locator('select[name="right"] option')).toHaveText([
    'Baseline (no artifact), repetition 1 (failed)',
    'Candidate (v1), repetition 1 (passed)',
    'Candidate (v1), repetition 2 (infrastructure-error)',
  ]);
  await page.locator('select[name="left"]').selectOption(COMPARE_AGENT_RUN.candidate);
  await page.getByRole('button', { name: 'Compare' }).click();
  await expect(page).toHaveURL(/left=arun_e2e123_cmp_cand/);
  await expect(page).toHaveURL(/path=src%2Frender\.php/);
  await expect(page.getByText('The files are identical.', { exact: true })).toBeVisible();

  // The right side kept no files: it says why, and the union comes from the left (D41).
  await page.goto(seeded({ right: COMPARE_AGENT_RUN.notKept, path: 'only-right.md' }));
  const status = page.getByRole('status').first();
  await expect(status).toContainText(`Right: Output files were not kept: ${NOT_KEPT_REASON}.`);
  await expect(status).toContainText(
    'only-right.md is not in either agent run, so the first file is shown.',
  );
  await expect(pathList(page).getByRole('listitem')).toHaveCount(LEFT_FILES.length);
  await expect(pathLink(page, 'deleted.txt')).toHaveAttribute('aria-current', 'page');
  // Browser QA finding 1: a run that kept no files cannot say what it lacks, so no path is
  // "Only left" and its column says why instead of "Not present in this agent run.".
  await expect(pathList(page)).not.toContainText('Only left');
  await expect(pathLink(page, 'same.js')).toContainText('Added');
  await page.goto(seeded({ right: COMPARE_AGENT_RUN.notKept, path: 'same.js' }));
  await expect(page.getByText('Not present in this agent run.')).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: /^Output files were not kept: / }),
  ).toHaveText(`Output files were not kept: ${NOT_KEPT_REASON}.`);

  // Neither side lists a file (D41).
  await page.goto(seeded({ left: COMPARE_AGENT_RUN.notKept, right: COMPARE_AGENT_RUN.notKept }));
  await expect(page.getByTestId('compare-empty')).toHaveText(
    'Neither agent run has a changed file to compare.',
  );
  await expect(pathList(page)).toHaveCount(0);
});

test('a case with one agent run compares it with itself (D40)', async ({ page }) => {
  await page.goto(comparePage(COMPARE_RUN, { case: LONELY_CASE }));
  await expect(page.locator('select[name="left"]')).toHaveValue(COMPARE_AGENT_RUN.lonely);
  await expect(page.locator('select[name="right"]')).toHaveValue(COMPARE_AGENT_RUN.lonely);
  await expect(page.getByText('The files are identical.', { exact: true })).toBeVisible();
});

test('a run without agent runs says so, and requested runs are not found (review finding)', async ({
  page,
}) => {
  await page.goto(comparePage(EMPTY_RUN));
  await expect(page.getByRole('heading', { level: 1, name: 'Compare output files' })).toBeVisible();
  await expect(page.getByText('No agent runs recorded.')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Agent runs to compare' })).toHaveCount(0);
  for (const query of [{ case: COMPARE_CASE }, { left: COMPARE_AGENT_RUN.baseline }] as Record<
    string,
    string
  >[]) {
    const response = await page.goto(comparePage(EMPTY_RUN, query));
    expect(response?.status()).toBe(404);
  }
});

test('foreign or unknown cases and agent runs render not found (§10)', async ({ page }) => {
  const demoAgentRun = await withDatabase(
    (db) =>
      (
        db
          .prepare('select id from agent_runs where benchmark_run_id = ? limit 1')
          .get(demoRunId(db)) as { id: string }
      ).id,
  );
  for (const url of [
    comparePage('run_missing'),
    seeded({ left: demoAgentRun }),
    seeded({ right: 'arun_missing' }),
    seeded({ left: COMPARE_AGENT_RUN.lonely }),
    comparePage(COMPARE_RUN, { case: 'no-such-case' }),
  ]) {
    const response = await page.goto(url);
    expect(response?.status(), url).toBe(404);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  }
  // Without ?case= the first case is used; an empty or repeated value counts as absent.
  for (const query of [{}, { case: '' }] as Record<string, string>[]) {
    await page.goto(comparePage(COMPARE_RUN, query));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Compare output files' }),
    ).toBeVisible();
  }
});

test('the compare page works with the keyboard only (D37, D44)', async ({ page }) => {
  await page.goto(seeded());
  const left = page.locator('select[name="left"]');
  await page.keyboard.press('Tab');
  let steps = 0;
  while (!(await left.evaluate((el) => el === document.activeElement)) && steps < 60) {
    await page.keyboard.press('Tab');
    steps += 1;
  }
  expect(steps).toBeLessThan(60);
  await left.selectOption(COMPARE_AGENT_RUN.candidate);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Compare' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/left=arun_e2e123_cmp_cand/);

  const target = pathLink(page, 'src/render.php');
  steps = 0;
  while (!(await target.evaluate((el) => el === document.activeElement)) && steps < 60) {
    await page.keyboard.press('Tab');
    steps += 1;
  }
  expect(steps).toBeLessThan(60);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/path=src%2Frender\.php#diff$/);
  await expect(target).toBeFocused();
  // Each side's scroll region is a tab stop after the list (D8, D17).
  const region = page.getByRole('region', { name: 'Left: src/render.php' });
  steps = 0;
  while (!(await region.evaluate((el) => el === document.activeElement)) && steps < 20) {
    await page.keyboard.press('Tab');
    steps += 1;
  }
  expect(steps).toBeLessThan(20);
});

test('choosing a path brings the diff into view (D44)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(seeded());
  const heading = page.getByRole('heading', { level: 3, name: 'src/render.php' });
  await pathLink(page, 'src/render.php').click();
  await expect(heading).toBeInViewport();
  await expect(pathLink(page, 'src/render.php')).toBeFocused();
});

test('the two sides sit side by side at 1280px and stack at 320px (D42, D14)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(seeded({ path: 'src/render.php' }));
  const left = page.getByRole('heading', { level: 4, name: /^Left:/ });
  const right = page.getByRole('heading', { level: 4, name: /^Right:/ });
  const [l, r] = [await left.boundingBox(), await right.boundingBox()];
  expect(Math.abs(l!.y - r!.y)).toBeLessThan(2);
  expect(r!.x).toBeGreaterThan(l!.x);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.reload();
  const [l2, r2] = [await left.boundingBox(), await right.boundingBox()];
  expect(r2!.y).toBeGreaterThan(l2!.y);
  await noHorizontalScroll(page);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the compare page has AA text contrast and fits 320px in ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: theme });
    const urls = [
      ...[
        'deleted.txt',
        'huge.txt',
        'only-left.txt',
        'only-right.md',
        'pic.png',
        'same.js',
        'src/render.php',
      ].map((path) => seeded({ path })),
      seeded({ right: COMPARE_AGENT_RUN.notKept, path: 'missing.txt' }),
      seeded({ left: COMPARE_AGENT_RUN.notKept, right: COMPARE_AGENT_RUN.notKept }),
      `/results/${COMPARE_RUN}`,
    ];
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const url of urls) {
        await page.goto(url);
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
        await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Not found');
        await page.evaluate(() => document.fonts.ready);
        await noHorizontalScroll(page);
        if (width === 320) continue;
        const failures = (await scanTextContrast(page)).filter((r) => r.ratio < r.threshold);
        expect.soft(failures, `${theme} ${url}`).toEqual([]);
      }
    }
  });
}
