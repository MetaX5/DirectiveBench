import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  ARTIFACT_PATH,
  BLIND_RUN,
  CANDIDATE_ONLY_PATH,
  HOSTILE_LINE,
  NO_PAIR_RUN,
  REVIEWED_RUN,
  RUNNING_RUN,
  TRACE_FRAGMENT,
  agentRunIds,
  cleanUp,
  reseed,
} from './blind-review-seed';
import { scanTextContrast } from './contrast';
import { MOCK_LABEL, count, withDatabase } from './support';

/**
 * SPEC-123 Phase 5: the blind review (FR-123-50 to FR-123-55, FR-123-52a, AC-7, decisions D46
 * to D57) on seeded mock-agent runs. The demo run is never reviewed here, so the other specs
 * keep its labelled views.
 */

const CLOSED =
  'A blind review of this run is in progress. Labelled output files and agent runs are hidden until you reveal it.';
const review = (runId: string, query: Record<string, string> = {}) => {
  const params = new URLSearchParams(query).toString();
  return `/results/${runId}/blind-review${params ? `?${params}` : ''}`;
};

async function noHorizontalScroll(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function tabTo(page: Page, target: ReturnType<Page['locator']>, limit = 80) {
  let steps = 0;
  while (!(await target.evaluate((el) => el === document.activeElement)) && steps < limit) {
    await page.keyboard.press('Tab');
    steps += 1;
  }
  expect(steps, 'reached by Tab').toBeLessThan(limit);
}

/** The HTML document and the RSC payload of a URL (the payload Next.js sends on navigation). */
async function bodies(request: APIRequestContext, url: string) {
  const html = await request.get(url);
  const rsc = await request.get(url, { headers: { RSC: '1' } });
  expect(rsc.headers()['content-type']).toContain('text/x-component');
  return { html: await html.text(), rsc: await rsc.text() };
}

/** The position the random shuffle gave the repetition-1 pair of a run (FR-123-51). */
async function repetitionOnePair(runId: string): Promise<string> {
  const ids = agentRunIds(runId);
  return withDatabase((db) => {
    const row = db
      .prepare(
        `select p.position from blind_review_pairs p join blind_reviews r on r.id = p.review_id
          where r.benchmark_run_id = ? and ? in (p.a_agent_run_id, p.b_agent_run_id)`,
      )
      .get(runId, ids.baseline1) as { position: number };
    return String(row.position);
  });
}

test.beforeAll(async () => withDatabase(reseed));
test.afterAll(async () => withDatabase(cleanUp));

test('the run page offers a blind review with its pairs and exclusions (D46, D47)', async ({
  page,
}) => {
  await page.goto(`/results/${BLIND_RUN}`);
  const card = page.getByTestId('blind-review');
  await expect(card.getByRole('heading', { name: 'Blind review' })).toBeVisible();
  await expect(card).toContainText(
    '2 pairs: one per case and repetition where both agent runs completed with kept files.',
  );
  await expect(card).toContainText('1 pair excluded: an agent run did not complete.');
  await expect(card.getByText(MOCK_LABEL)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Start blind review' })).toBeVisible();
  // Next to the verdict, before the agent profile (D46).
  const order = await page
    .locator('[data-testid="blind-review"], [data-testid="agent-profile"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(order).toEqual(['blind-review', 'agent-profile']);

  await page.goto(`/results/${NO_PAIR_RUN}`);
  await expect(page.getByTestId('blind-review-unavailable')).toHaveText(
    'No pair of completed agent runs with kept files.',
  );
  await expect(page.getByRole('button', { name: 'Start blind review' })).toHaveCount(0);

  await page.goto(`/results/${RUNNING_RUN}`);
  await expect(page.getByTestId('blind-review-unavailable')).toHaveText(
    'A blind review can start after the run has completed.',
  );
  await expect(page.getByRole('button', { name: 'Start blind review' })).toHaveCount(0);
});

test('a run without a review says so, and an unknown run is not found (D56)', async ({ page }) => {
  await page.goto(review(BLIND_RUN));
  await expect(page.getByRole('heading', { level: 1, name: 'Blind review' })).toBeVisible();
  await expect(
    page.getByText('This run has no blind review. Start one from the run page.'),
  ).toBeVisible();
  await page.goto(review('run_missing'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found');
});

test('an unrevealed review cannot be identified through any labelled page, HTML or RSC (AC-7, FR-123-52a)', async ({
  request,
}) => {
  const ids = Object.values(agentRunIds(REVIEWED_RUN));
  const labelled = [
    `/results/${REVIEWED_RUN}`,
    `/results/${REVIEWED_RUN}/compare`,
    `/results/${REVIEWED_RUN}/compare?case=implement-parse-age&left=${ids[0]}&right=${ids[1]}&path=src%2Fanswer.js`,
    ...ids.map((id) => `/results/${REVIEWED_RUN}/agent-runs/${id}`),
    ...ids.map((id) => `/results/${REVIEWED_RUN}/agent-runs/${id}?path=src%2Fanswer.js`),
  ];
  const reviewPages = [
    review(REVIEWED_RUN),
    review(REVIEWED_RUN, { pair: '1', path: CANDIDATE_ONLY_PATH }),
    review(REVIEWED_RUN, { pair: '1', path: 'src/answer.js' }),
    review(REVIEWED_RUN, { pair: '2' }),
  ];
  for (const url of [...labelled, ...reviewPages]) {
    const { html, rsc } = await bodies(request, url);
    for (const [kind, body] of [
      ['HTML', html],
      ['RSC', rsc],
    ] as const) {
      const where = `${kind} of ${url}`;
      // No agent-run id, except the one the URL itself names (the user typed it).
      for (const id of ids.filter((id) => !url.includes(id))) {
        expect(body, `${where}: ${id}`).not.toContain(id);
      }
      expect(body, where).not.toContain('data-testid="agent-run"');
      expect(body, where).not.toContain(TRACE_FRAGMENT);
      expect(body, where).not.toContain(ARTIFACT_PATH);
      expect(body, where).not.toMatch(/repetition|· rep \d/);
      expect(body, where).not.toMatch(/"variant"|"executionStatus"|"score"/);
      if (labelled.includes(url)) {
        expect(body, where).toContain(CLOSED);
        expect(body, where).not.toContain('src/answer.js"');
        expect(body, where).not.toContain(CANDIDATE_ONLY_PATH);
      } else {
        // The review page names no variant at all before the reveal.
        expect(body, where).not.toMatch(/Baseline \(|Candidate \(/);
      }
    }
  }
});

test.describe.serial('start, verdicts and reveal', () => {
  test('starting a review goes to its page and closes the labelled views (FR-123-50, D55)', async ({
    page,
  }) => {
    await page.goto(`/results/${BLIND_RUN}`);
    await page.getByRole('button', { name: 'Start blind review' }).click();
    await expect(page).toHaveURL(new RegExp(`/results/${BLIND_RUN}/blind-review\\?pair=1$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Blind review' })).toBeVisible();
    await expect(page.getByText(/^Pair 1 of 2 · Case implement-parse-age/)).toBeVisible();
    await expect(page.getByTestId('pairs-decided')).toHaveText('Pairs decided: 0 of 2');
    await expect(page.getByText(MOCK_LABEL)).toBeVisible();
    expect(
      await withDatabase((db) =>
        count(
          db,
          'select count(*) as n from blind_review_pairs p join blind_reviews r on r.id = p.review_id where r.benchmark_run_id = ?',
          BLIND_RUN,
        ),
      ),
    ).toBe(2);

    await page.getByRole('link', { name: 'Back to the run' }).click();
    await expect(page.getByTestId('output-files-closed')).toContainText(CLOSED);
    await expect(page.getByTestId('agent-runs-closed')).toContainText(CLOSED);
    await expect(page.getByTestId('agent-run')).toHaveCount(0);
    await expect(page.getByTestId('blind-review-progress')).toHaveText('Pairs decided: 0 of 2');
    // The aggregates and the header stay (FR-123-52a).
    await expect(page.getByTestId('run-variants')).toBeVisible();
    await page
      .getByTestId('blind-review')
      .getByRole('link', { name: 'Continue the blind review' })
      .click();
    await expect(page).toHaveURL(new RegExp(`/results/${BLIND_RUN}/blind-review\\?pair=1$`));
  });

  test('a pair shows the task, the paths of A and B and a neutral diff (FR-123-52, D48, D50)', async ({
    page,
  }) => {
    await page.goto(review(BLIND_RUN, { pair: await repetitionOnePair(BLIND_RUN) }));
    await expect(page.getByRole('heading', { name: 'Task' })).toBeVisible();
    await expect(page.locator('pre').first()).toContainText('parseAge');
    await expect(
      page.getByText('content written by the agent may still hint at the variant', {
        exact: false,
      }),
    ).toBeVisible();
    const paths = page.getByRole('navigation', { name: 'Changed paths' });
    await expect(paths.getByRole('link')).toHaveCount(2);
    await expect(paths).not.toContainText(ARTIFACT_PATH);
    await expect(paths.getByRole('link', { name: new RegExp(CANDIDATE_ONLY_PATH) })).toContainText(
      /Only (A|B)/,
    );
    await expect(paths.getByRole('link', { name: /^src\/answer\.js/ })).toContainText('Differs');
    await paths.getByRole('link', { name: /^src\/answer\.js/ }).click();
    await expect(page).toHaveURL(/path=src%2Fanswer\.js#diff$/);
    // Sides are named A and B only, with the neutral markers (D12, D13).
    await expect(page.getByRole('heading', { level: 4, name: 'A', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 4, name: 'B', exact: true })).toBeVisible();
    await expect(page.getByText(/^Only in (A|B):/).first()).toBeAttached();
    await expect(page.getByText('Removed:')).toHaveCount(0);

    // Hostile markup is text.
    await paths.getByRole('link', { name: new RegExp(CANDIDATE_ONLY_PATH) }).click();
    await expect(page.getByText(HOSTILE_LINE)).toBeVisible();
    expect(await page.evaluate(() => (window as { __hostileBlind?: number }).__hostileBlind)).toBe(
      undefined,
    );
    await expect(page.getByText('Not present in this agent run.')).toBeVisible();
  });

  test('a verdict is recorded once, by keyboard, with a note (FR-123-53, D51, D52)', async ({
    page,
  }) => {
    await page.goto(review(BLIND_RUN));
    // Without ?pair= the page goes to the first pair without a verdict, named in the URL.
    await expect(page).toHaveURL(/blind-review\?pair=1$/);
    await expect(page.getByText(/^Pair 1 of 2/)).toBeVisible();
    const note = page.getByRole('textbox', { name: 'Note (optional)' });
    // A long word in the note must not squeeze the result table (browser QA finding 2).
    await note.fill(`A keeps the export.\nShorter. ${'x'.repeat(600)}`);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'A is better, pair 1' })).toBeFocused();
    await page.keyboard.press('Enter');
    const status = page.getByTestId('verdict-status');
    await expect(status).toContainText('Verdict recorded.');
    await expect(status).toBeFocused();
    await expect(page.getByTestId('verdict-recorded')).toContainText('Your verdict: A is better.');
    await expect(page.getByTestId('verdict-recorded')).toContainText('A keeps the export.');
    await expect(page.getByTestId('pairs-decided')).toHaveText('Pairs decided: 1 of 2');
    await expect(page.getByRole('button', { name: /is better, pair 1/ })).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Pairs' }).getByRole('link', { name: /^Pair 1/ }),
    ).toHaveText('Pair 1 · implement-parse-age · A is better');

    await status.getByRole('link', { name: 'Next pair without a verdict' }).click();
    await expect(page).toHaveURL(/pair=2$/);
    // Browser QA finding 1: clicks in the same tick post once, so the first choice is recorded
    // and its own result line is shown (not "This pair already has a verdict.").
    await page.getByRole('button', { name: 'About the same, pair 2' }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
      document
        .querySelector<HTMLButtonElement>('button[aria-label="B is better, pair 2"]')!
        .click();
    });
    await expect(page.getByTestId('verdict-status')).toHaveText(
      'Verdict recorded. All pairs have a verdict. You can reveal the variants.',
    );
    await expect(page.getByTestId('verdict-recorded')).toContainText(
      'Your verdict: About the same.',
    );

    // A reload shows the stored verdict, not a form (immutable).
    await page.goto(review(BLIND_RUN, { pair: '1' }));
    await expect(page.getByTestId('verdict-recorded')).toContainText('Your verdict: A is better.');
    await expect(page.getByRole('textbox', { name: 'Note (optional)' })).toHaveCount(0);
  });

  test('the reveal asks first, then shows every side and the summary (FR-123-54, D53, D54)', async ({
    page,
  }) => {
    await page.goto(review(BLIND_RUN, { pair: await repetitionOnePair(BLIND_RUN) }));
    const opener = page.getByTestId('reveal-card').getByRole('button', { name: 'Reveal variants' });
    await opener.click();
    const panel = page.getByTestId('reveal-confirmation');
    await expect(panel).toContainText('Reveal the variants of this blind review?');
    await expect(panel.getByRole('button', { name: 'Reveal variants' })).toBeFocused();
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await panel.getByRole('button', { name: 'Reveal variants' }).click();
    const result = page.getByTestId('blind-review-result');
    await expect(result).toBeVisible();
    await expect(page.getByTestId('blind-review-summary')).toHaveText(
      /^Candidate preferred in [01] of 2 pairs, baseline in [01], about the same in 1, no verdict in 0\.$/,
    );
    const table = page.getByRole('table', { name: 'Blind review result' });
    await expect(table.getByRole('row')).toHaveCount(3);
    // Browser QA finding 2: the case id stays on one line, at 1280px and at 320px.
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const lines = await table
        .getByRole('cell', { name: 'implement-parse-age' })
        .first()
        .evaluate((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        });
      expect(lines, `case id lines at ${width}px`).toBe(1);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(table).toContainText('About the same');
    await expect(page.getByTestId('reveal-card')).toHaveCount(0);
    await expect(page.getByTestId('reveal-status')).toHaveText(
      'Variants revealed. The blind review has ended.',
    );
    // The sides now carry their variant (D13) and link to their files.
    await expect(
      page.getByRole('heading', {
        level: 4,
        name: /^A: (Baseline \(no artifact\)|Candidate \(v1\)), repetition 1$/,
      }),
    ).toBeVisible();
    await expect(page.getByTestId('revealed-sides').getByRole('link')).toHaveCount(2);

    // The run page shows the summary next to the verdict and every labelled view again.
    await page.getByRole('link', { name: 'Back to the run' }).click();
    const card = page.getByTestId('blind-review');
    await expect(card).toContainText('Human blind review');
    await expect(card.getByTestId('blind-review-summary')).toHaveText(
      /^Candidate preferred in [01] of 2 pairs/,
    );
    await expect(page.getByTestId('agent-run')).toHaveCount(6);
    await expect(page.getByTestId('output-files')).toBeVisible();
    await expect(page.getByTestId('output-files-closed')).toHaveCount(0);
    await card.getByRole('link', { name: 'View the review' }).click();
    await expect(page.getByTestId('blind-review-result')).toBeVisible();
    await expect(page.getByText('No verdict was recorded for this pair.')).toHaveCount(0);
  });

  test('the revealed review works at 320px and in both themes with AA contrast', async ({
    page,
  }) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const url of [review(BLIND_RUN, { pair: '1' }), `/results/${BLIND_RUN}`]) {
          await page.goto(url);
          await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
          await page.evaluate(() => document.fonts.ready);
          await noHorizontalScroll(page);
          const failures = (await scanTextContrast(page)).filter((r) => r.ratio < r.threshold);
          expect.soft(failures, `${theme} ${width} ${url}`).toEqual([]);
        }
      }
    }
  });
});

test('not found for a pair or path the review does not have (§10, D49, D50)', async ({ page }) => {
  const queries: Record<string, string>[] = [
    { pair: '0' },
    { pair: '3' },
    { pair: 'x' },
    { pair: '1', path: 'missing.txt' },
    { pair: '1', path: ARTIFACT_PATH },
  ];
  for (const query of queries) {
    await page.goto(review(REVIEWED_RUN, query));
    await expect(page.getByRole('heading', { level: 1 }), JSON.stringify(query)).toHaveText(
      'Not found',
    );
  }
});

test('the unrevealed review works with the keyboard only (D57)', async ({ page }) => {
  await page.goto(review(REVIEWED_RUN, { pair: '1' }));
  await page.keyboard.press('Tab');
  const pair2 = page
    .getByRole('navigation', { name: 'Pairs' })
    .getByRole('link', { name: /^Pair 2/ });
  await tabTo(page, pair2);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/pair=2$/);
  const path = page.getByRole('navigation', { name: 'Changed paths' }).getByRole('link').first();
  await tabTo(page, path);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/path=same\.txt#diff$/);
  await tabTo(page, page.getByRole('region', { name: 'A: same.txt' }));
  await tabTo(page, page.getByRole('textbox', { name: 'Note (optional)' }));
  await tabTo(page, page.getByRole('button', { name: 'A is better, pair 2' }));
  await tabTo(page, page.getByRole('button', { name: 'Reveal variants' }));
  await page.keyboard.press('Enter');
  await expect(
    page.getByTestId('reveal-confirmation').getByRole('button', { name: 'Reveal variants' }),
  ).toBeFocused();
  // Cancelled: the seeded review stays unrevealed for the other tests.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('reveal-confirmation')).toHaveCount(0);
});

test('the unrevealed pages fit 320px, stack A above B and reach AA contrast in both themes (D57)', async ({
  page,
}) => {
  test.setTimeout(90_000);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const urls = [
        review(REVIEWED_RUN, { pair: '1', path: 'src/answer.js' }),
        review(REVIEWED_RUN, { pair: '2' }),
        `/results/${REVIEWED_RUN}`,
        `/results/${REVIEWED_RUN}/agent-runs/${agentRunIds(REVIEWED_RUN).baseline1}`,
        `/results/${REVIEWED_RUN}/compare`,
        `/results/${NO_PAIR_RUN}`,
      ];
      for (const url of urls) {
        await page.goto(url);
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
        await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Not found');
        await page.evaluate(() => document.fonts.ready);
        await noHorizontalScroll(page);
        if (url.includes('pair=1')) {
          const a = await page
            .getByRole('heading', { level: 4, name: 'A', exact: true })
            .boundingBox();
          const b = await page
            .getByRole('heading', { level: 4, name: 'B', exact: true })
            .boundingBox();
          if (width === 320) expect(b!.y).toBeGreaterThan(a!.y);
          else expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
          // The confirmation panel is part of the page too.
          await page
            .getByTestId('reveal-card')
            .getByRole('button', { name: 'Reveal variants' })
            .click();
          await expect(page.getByTestId('reveal-confirmation')).toBeVisible();
          await noHorizontalScroll(page);
        }
        const failures = (await scanTextContrast(page)).filter((r) => r.ratio < r.threshold);
        expect.soft(failures, `${theme} ${width} ${url}`).toEqual([]);
      }
    }
  }
});
