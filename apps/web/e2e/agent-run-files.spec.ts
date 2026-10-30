import { expect, test, type Page } from '@playwright/test';
import { scanTextContrast } from './contrast';
import {
  AGENT_RUN,
  CASE_ID,
  CODE_FILES,
  CODE_RUN,
  FILES,
  FILES_RUN,
  HOSTILE_LINES,
  OLD_RUN,
  TIMEOUT_REASON,
  cleanUp,
  reseed,
} from './output-files-seed';
import {
  MOCK_LABEL,
  demoRunId,
  escapeRegExp,
  keptFiles,
  shownFileLines,
  storedFileLines,
  withDatabase,
} from './support';

/**
 * SPEC-123 Phase 3: the "Output files" card on the run page and the agent-run files page
 * (FR-123-20, FR-123-21, FR-123-22, decisions D21 to D34), on the demo run and on seeded rows
 * that cover every file and agent-run state.
 */

const filesPage = (runId: string, agentRunId: string, query = '') =>
  `/results/${runId}/agent-runs/${agentRunId}${query}`;

async function noHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test.beforeAll(async () => withDatabase(reseed));
test.afterAll(async () => withDatabase(cleanUp));

test('the demo run lists each agent run with its files and opens them (FR-123-20, FR-123-21)', async ({
  page,
}) => {
  const runId = await withDatabase(demoRunId);
  await page.goto(`/results/${runId}`);
  const card = page.getByTestId('output-files');
  await expect(card.getByRole('heading', { name: 'Output files' })).toBeVisible();
  // D21: after the warnings, before the Agent runs section.
  const order = await page
    .locator('[data-slot="card-title"]')
    .evaluateAll((titles) => titles.map((t) => t.textContent));
  expect(order.indexOf('Output files')).toBe(order.indexOf('Agent runs') - 1);

  const table = card.getByRole('table', { name: 'Output files of case implement-parse-age' });
  await expect(table.getByRole('row')).toHaveCount(7);
  const first = table.getByRole('row').nth(1);
  await expect(first).toContainText('Baseline (no artifact), repetition 1');
  await expect(first).toContainText('failed');
  await expect(first).toContainText('184 bytes');
  await expect(first).toContainText('None');

  await table
    .getByRole('link', {
      name: 'View files of Candidate (v1), repetition 2, case implement-parse-age',
    })
    .click();
  await expect(page).toHaveURL(/\/agent-runs\/arun_/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Candidate (v1), repetition 2' }),
  ).toBeVisible();
  await expect(page.getByText(MOCK_LABEL)).toBeVisible();
  await expect(page.getByText('passed', { exact: true })).toBeVisible();
  const list = page.getByRole('navigation', { name: 'Changed files' });
  await expect(list.getByRole('link')).toHaveCount(1);
  // D32: without ?path= the first file is shown and marked current.
  await expect(list.getByRole('link', { name: /src\/parse-age\.js/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const content = page.getByRole('region', { name: 'Content of src/parse-age.js' });
  await expect(content).toContainText('export function parseAge');

  await page.getByRole('link', { name: 'Back to the run' }).click();
  await expect(page).toHaveURL(new RegExp(`/results/${runId}$`));
});

test('every file of every agent run of the demo run is readable in full (AC-1)', async ({
  page,
}) => {
  const runId = await withDatabase(demoRunId);
  const files = await withDatabase((db) => keptFiles(db, runId));
  // One case, three repetitions, both variants: every one of them kept its file.
  expect(files.map((f) => `${f.variant}-${f.repetition}`)).toEqual([
    'baseline-1',
    'baseline-2',
    'baseline-3',
    'candidate-1',
    'candidate-2',
    'candidate-3',
  ]);
  for (const file of files) {
    await page.goto(filesPage(runId, file.agentRunId, `?path=${encodeURIComponent(file.path)}`));
    expect(await shownFileLines(page, file.path)).toEqual(storedFileLines(file.content));
  }
});

test('the card shows counts, reasons and pre-capture agent runs (D23, D25, D26)', async ({
  page,
}) => {
  await page.goto(`/results/${FILES_RUN}`);
  const table = page
    .getByTestId('output-files')
    .getByRole('table', { name: `Output files of case ${CASE_ID}` });
  const rows = table.getByRole('row');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(1)).toContainText('Baseline (no artifact), repetition 1');
  await expect(rows.nth(1)).toContainText(String(FILES.length));
  await expect(rows.nth(1)).toContainText('2 truncated, 4 not kept');
  await expect(rows.nth(2)).toContainText('Candidate (v1), repetition 1');
  await expect(rows.nth(2)).toContainText('0 bytes');
  await expect(rows.nth(3)).toContainText('timeout');
  await expect(rows.nth(3)).toContainText(`Not kept: ${TIMEOUT_REASON}.`);
  await expect(rows.nth(3).getByRole('cell').nth(2)).toHaveText('3');
  await expect(rows.nth(4)).toContainText('Not kept: this agent run predates output file capture.');
  // Every row keeps its link; the files page explains a missing list (D25).
  await expect(table.getByRole('link', { name: /^View files of / })).toHaveCount(4);

  await page.goto(`/results/${OLD_RUN}`);
  const card = page.getByTestId('output-files');
  await expect(card).toContainText('Output files were not kept for this run.');
  await expect(card.getByRole('table')).toHaveCount(0);
});

test('the files page lists every file state and shows its notices (FR-123-21)', async ({
  page,
}) => {
  await page.goto(filesPage(FILES_RUN, AGENT_RUN.rich));
  await expect(
    page.getByRole('heading', { name: `Changed files (${FILES.length})` }),
  ).toBeVisible();
  const list = page.getByRole('navigation', { name: 'Changed files' });
  // D31: ordered by path.
  await expect(list.getByRole('listitem')).toHaveCount(FILES.length);
  for (const [i, file] of FILES.entries()) {
    await expect(list.getByRole('listitem').nth(i)).toContainText(file.path);
  }
  const item = (path: string) => list.getByRole('listitem').filter({ hasText: path });
  await expect(item('big.log')).toContainText('Truncated');
  await expect(item('img.png')).toContainText('Binary, not kept');
  await expect(item('old.txt')).toContainText('Deleted');
  await expect(item('skill/SKILL.md')).toContainText('Artifact file');
  await expect(item('zz-not-kept.txt')).toContainText('Not kept');
  await expect(item('a/hostile.html')).toContainText('1 redacted');

  const status = page.getByRole('status');
  const notices: [string, string][] = [
    ['big.log', 'Truncated at 1 MB: the file has 2,000,000 bytes.'],
    ['run-cut.txt', 'Truncated: the 10 MB limit for this agent run was reached.'],
    ['img.png', 'Binary file, not kept.'],
    ['old.txt', 'Deleted by the agent.'],
    ['skill/SKILL.md', 'Artifact file, not kept.'],
    ['zz-not-kept.txt', 'Not kept: the 10 MB limit for this agent run was reached.'],
    ['empty.txt', 'The file is empty.'],
  ];
  for (const [path, notice] of notices) {
    await list.getByRole('link', { name: new RegExp(escapeRegExp(path)) }).click();
    await expect(page).toHaveURL(new RegExp(`path=${encodeURIComponent(path)}#file$`));
    await expect(list.getByRole('link', { name: new RegExp(escapeRegExp(path)) })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(status).toContainText(notice);
  }
});

test('agent-written markup is shown as text, never run (SPEC-123 §12)', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.goto(filesPage(FILES_RUN, AGENT_RUN.rich, '?path=a%2Fhostile.html'));
  const content = page.getByRole('region', { name: 'Content of a/hostile.html' });
  for (const line of HOSTILE_LINES) await expect(content).toContainText(line);
  await expect(page.getByRole('status')).toContainText('1 secret redacted.');
  await expect(page.getByRole('status')).toContainText('Shown with LF line endings.');
  expect(await page.evaluate(() => (window as { __hostile?: number }).__hostile)).toBeUndefined();
  await expect(content.locator('script, img')).toHaveCount(0);
  // Highlighted since Phase 3a, and still text: tokens are React text nodes (AC-15).
  await expect(content.locator('[data-highlighted]')).toHaveCount(HOSTILE_LINES.length);
  // The <img src=x> was never created, so nothing fetched it.
  expect(requested.filter((url) => /\/x$/.test(url))).toEqual([]);
});

test('code files are highlighted on the server, the browser loads no highlighter (SPEC-123 §6.7)', async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on('response', async (response) => {
    if (response.request().resourceType() === 'script')
      scripts.push(await response.text().catch(() => ''));
  });
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));

  // The demo run's file: every line is tokenized (AC-12).
  const runId = await withDatabase(demoRunId);
  await page.goto(`/results/${runId}`);
  await page
    .getByTestId('output-files')
    .getByRole('link', { name: /^View files of / })
    .first()
    .click();
  const demo = page.getByRole('region', { name: 'Content of src/parse-age.js' });
  await expect(demo.locator('[data-highlighted]').first()).toBeVisible();
  await expect(demo.locator('.text-syntax-token-keyword').first()).toBeVisible();

  const open = (path: string) =>
    page.goto(filesPage(CODE_RUN, AGENT_RUN.code, `?path=${encodeURIComponent(path)}`));
  const region = (path: string) => page.getByRole('region', { name: `Content of ${path}` });

  await open('src/add.ts');
  const lines = CODE_FILES['src/add.ts']!.split('\n').length - 1;
  await expect(region('src/add.ts').locator('[data-highlighted]')).toHaveCount(lines);
  for (const kind of ['comment', 'keyword', 'string-expression', 'constant', 'function']) {
    await expect(region('src/add.ts').locator(`.text-syntax-token-${kind}`).first()).toBeVisible();
  }
  await expect(region('src/add.ts')).toContainText('return `${total} items`');
  await expect(page.getByRole('status')).toHaveCount(0);

  // Over 256 KB: plain, with the note (AC-13).
  await open('build/bundle.ts');
  await expect(page.getByRole('status')).toHaveText(
    'Syntax highlighting is off for files over 256 KB.',
  );
  await expect(region('build/bundle.ts').locator('[data-highlighted]')).toHaveCount(0);

  // No listed extension: plain, no note (AC-13).
  await open('notes.txt');
  await expect(region('notes.txt')).toContainText('const a = 1;');
  await expect(region('notes.txt').locator('[data-highlighted]')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);

  // FR-123-70: no Shiki code, grammar or worker entry reached the browser.
  expect(scripts.length).toBeGreaterThan(0);
  for (const body of scripts) {
    expect(body).not.toContain('tokenizeTimeLimit');
    expect(body).not.toContain('text.html.php');
  }
  expect(requested.filter((url) => url.includes('syntax-highlight'))).toEqual([]);
});

test('agent runs without a file list say why (D34)', async ({ page }) => {
  const cases: [string, string][] = [
    [AGENT_RUN.none, 'The agent did not change any file.'],
    [AGENT_RUN.reason, `Output files were not kept: ${TIMEOUT_REASON}.`],
    [AGENT_RUN.old, 'Output files were not kept for this agent run.'],
  ];
  for (const [agentRunId, sentence] of cases) {
    await page.goto(filesPage(FILES_RUN, agentRunId));
    await expect(page.getByTestId('agent-run-files-notice')).toHaveText(sentence);
    await expect(page.getByRole('navigation', { name: 'Changed files' })).toHaveCount(0);
  }
  // D28: the header carries the agent run's execution status.
  await page.goto(filesPage(FILES_RUN, AGENT_RUN.reason));
  await expect(page.getByText('timeout', { exact: true })).toBeVisible();
});

test('foreign or unknown ids and paths render not found (D33, FR-123-21)', async ({ page }) => {
  const demoAgentRun = await withDatabase(
    (db) =>
      (
        db
          .prepare('select id from agent_runs where benchmark_run_id = ? limit 1')
          .get(demoRunId(db)) as { id: string }
      ).id,
  );
  for (const url of [
    filesPage(FILES_RUN, demoAgentRun),
    filesPage(FILES_RUN, 'arun_missing'),
    filesPage('run_missing', AGENT_RUN.rich),
    filesPage(FILES_RUN, AGENT_RUN.rich, '?path=missing.txt'),
    filesPage(FILES_RUN, AGENT_RUN.none, '?path=a%2Fhostile.html'),
  ]) {
    const response = await page.goto(url);
    expect(response?.status(), url).toBe(404);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  }
  // An empty or repeated ?path= counts as absent: the first file is shown.
  for (const query of ['?path=', '?path=big.log&path=img.png']) {
    await page.goto(filesPage(FILES_RUN, AGENT_RUN.rich, query));
    await expect(page.getByRole('region', { name: 'Content of a/hostile.html' })).toBeVisible();
  }
});

test('the files page works with the keyboard only', async ({ page }) => {
  await page.goto(filesPage(FILES_RUN, AGENT_RUN.rich));
  const list = page.getByRole('navigation', { name: 'Changed files' });
  const target = list.getByRole('link', { name: /big\.log/ });
  await page.keyboard.press('Tab');
  let steps = 0;
  while (!(await target.evaluate((el) => el === document.activeElement)) && steps < 60) {
    await page.keyboard.press('Tab');
    steps += 1;
  }
  expect(steps).toBeLessThan(60);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/path=big\.log#file$/);
  // The file's scroll region is one tab stop after the list (D8, D17).
  const region = page.getByRole('region', { name: 'Content of big.log' });
  steps = 0;
  while (!(await region.evaluate((el) => el === document.activeElement)) && steps < 20) {
    await page.keyboard.press('Tab');
    steps += 1;
  }
  expect(steps).toBeLessThan(20);
});

test('on a wide screen choosing a file keeps the page where it is (maintainer decision on #162)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(filesPage(FILES_RUN, AGENT_RUN.rich));
  const heading = page.getByRole('heading', { level: 1 });
  const link = page
    .getByRole('navigation', { name: 'Changed files' })
    .getByRole('link', { name: /zz-not-kept\.txt/ });
  // Playwright may scroll a little to reach the link; the page itself must not scroll further.
  await link.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  await link.click();
  await expect(page.getByRole('heading', { level: 3, name: 'zz-not-kept.txt' })).toBeVisible();
  await expect(page).toHaveURL(/path=zz-not-kept\.txt#file$/);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await expect(heading).toBeInViewport();
  await expect(page.getByRole('link', { name: 'Back to the run' })).toBeInViewport();
  // Opening the URL with the fragment in a fresh document does not scroll either.
  await page.goto('about:blank');
  await page.goto(filesPage(FILES_RUN, AGENT_RUN.rich, '?path=zz-not-kept.txt#file'));
  await expect(page.getByRole('heading', { level: 3, name: 'zz-not-kept.txt' })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('at 320px choosing a file brings it into view (browser QA finding 1)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(filesPage(FILES_RUN, AGENT_RUN.rich));
  // Precondition: the file is stacked far below the top of the list, out of view.
  const fileHeading = (path: string) => page.getByRole('heading', { level: 3, name: path });
  await expect(fileHeading('a/hostile.html')).not.toBeInViewport();
  const link = page
    .getByRole('navigation', { name: 'Changed files' })
    .getByRole('link', { name: /big\.log/ });
  await expect(link).toBeInViewport();
  await link.click();
  await expect(page).toHaveURL(/path=big\.log#file$/);
  await expect(fileHeading('big.log')).toBeInViewport();
  await expect(link).toBeFocused();
  // A fresh document with the #file URL also opens at the file.
  await page.goto('about:blank');
  await page.goto(filesPage(FILES_RUN, AGENT_RUN.rich, '?path=empty.txt#file'));
  await expect(fileHeading('empty.txt')).toBeInViewport();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the card and the files page have AA text contrast and fit 320px in ${theme}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: theme });
    const urls = [
      `/results/${FILES_RUN}`,
      `/results/${OLD_RUN}`,
      ...FILES.map((f) =>
        filesPage(FILES_RUN, AGENT_RUN.rich, `?path=${encodeURIComponent(f.path)}`),
      ),
      filesPage(FILES_RUN, AGENT_RUN.reason),
      ...Object.keys(CODE_FILES).map((path) =>
        filesPage(CODE_RUN, AGENT_RUN.code, `?path=${encodeURIComponent(path)}`),
      ),
    ];
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const url of urls) {
        await page.goto(url);
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
        // Measure the real page, never the not-found page.
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
