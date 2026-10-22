import { expect, test } from '@playwright/test';
import { ARTIFACT, cleanUp, deleteRuns, reseed, RUN, SUITE } from './results-seed';
import { MOCK_LABEL, withDatabase } from './support';

/**
 * Issue #98 (E06-S05, SPEC-118 §6.6 FR-118-50…53, §11, AC-12 and the regression part of AC-19):
 * the artifact page shows runs per version and comparability group with baseline, auth mode and
 * isolation, highlights a version regression within a group, and the run detail names the
 * baseline and shows the agent profile, warnings, tokens as reported and assertion details.
 * Seeded runs only — no agent runs here — removed again after the tests.
 */

test.beforeAll(() => withDatabase(reseed));
test.afterAll(() => withDatabase(cleanUp));

test('the artifact page lists runs per version and comparability group and highlights a version regression (AC-12, AC-19)', async ({
  page,
}) => {
  await page.goto(`/artifacts/${ARTIFACT}?tab=evaluations`);
  await expect(page.getByRole('heading', { name: 'Benchmark results by version' })).toBeVisible();

  const blocks = page.getByTestId('version-results');
  await expect(blocks).toHaveCount(3);
  expect(await blocks.evaluateAll((els) => els.map((el) => el.dataset.version))).toEqual([
    '3',
    '2',
    '1',
  ]);
  const v3 = page.getByRole('region', { name: 'Version 3' });
  await expect(v3).toContainText('No completed runs for this version.');

  await expect(page.getByTestId('not-comparable-notice')).toContainText(
    '2 comparability groups that are not comparable with each other',
  );
  const v2 = page.getByRole('region', { name: 'Version 2' });
  await expect(v2.getByTestId('comparability-group')).toHaveCount(2);
  await expect(v2.getByTestId('comparability-group').first()).toContainText(
    'not comparable with other groups',
  );

  // The A/B run of v2: baseline v1, subscription in the user's profile, and a version regression
  // against v1 in its group (score 90% → 50%, passed → failed).
  const ab = page.locator(`[data-run-id="${RUN.v2Ab}"]`);
  await expect(ab.getByTestId('run-baseline')).toHaveText('v1');
  await expect(ab).toContainText('claude-code 2.1.302');
  await expect(ab.getByTestId('run-conditions')).toHaveText('subscription · user-profile');
  await expect(ab).toContainText('May include user-level instructions');
  await expect(ab).toContainText('agent default → claude-sonnet-4-6');
  await expect(ab.locator('[data-status]')).toHaveAttribute('data-status', 'failed');
  await expect(ab.getByTestId('version-regression')).toHaveText(
    'Version regression vs v1 (-40 pts)',
  );
  await expect(ab.getByTestId('comparison-reason')).toHaveText(
    'candidate score fell by at least minDelta (0.05); candidate outcome changed from passed to failed',
  );
  await expect(ab).toContainText('low');
  await expect(v2.getByText('Version regression', { exact: true })).toBeVisible();

  // The other group: baseline "no artifact", API key mode, isolated; v2 is better than v1 there.
  const api = page.locator(`[data-run-id="${RUN.v2Api}"]`);
  await expect(api.getByTestId('run-baseline')).toHaveText('no artifact');
  await expect(api.getByTestId('run-conditions')).toHaveText('api-key · isolated');
  await expect(api).not.toContainText('May include user-level instructions');
  await expect(api.getByTestId('version-comparison')).toHaveText('No regression vs v1 (+10 pts)');

  // v1 runs start each group: nothing to compare with, and no regression on the version.
  const v1 = page.getByRole('region', { name: 'Version 1' });
  await expect(v1.getByTestId('version-regression')).toHaveCount(0);
  await expect(v1.getByTestId('version-comparison')).toHaveCount(0);
  // Seeded real-agent runs never carry the mock label.
  await expect(page.getByText(MOCK_LABEL)).toHaveCount(0);

  await ab.getByRole('link', { name: RUN.v2Ab }).click();
  await expect(page).toHaveURL(new RegExp(`/results/${RUN.v2Ab}$`));
});

test('the run detail names the baseline and shows the agent profile, warnings, usage and assertion details (AC-12, FR-118-52)', async ({
  page,
}) => {
  await page.goto(`/results/${RUN.v2Ab}`);
  await expect(page.getByTestId('run-variants')).toHaveText('Baseline (v1) vs Candidate (v2)');
  await expect(page.getByTestId('baseline-score-label')).toHaveText('Baseline (v1)');
  await expect(page.getByTestId('candidate-score-label')).toHaveText('Candidate (v2)');
  await expect(page.getByTestId('baseline-score-invocation')).toHaveText(
    'Skill invoked in 1/1 runs',
  );
  await expect(page.getByTestId('candidate-score-invocation')).toHaveText(
    'Skill invoked in 0/1 runs',
  );
  await expect(page.getByTestId('real-agent-badge')).toHaveText(
    'Real agent — results vary between runs',
  );
  await expect(page.getByText(MOCK_LABEL)).toHaveCount(0);

  const profile = page.getByTestId('agent-profile');
  await expect(profile.getByTestId('profile-auth-mode')).toHaveText('subscription');
  await expect(profile.getByTestId('profile-isolation')).toHaveText('user-profile');
  await expect(profile.getByTestId('profile-permission')).toHaveText('edit-only');
  await expect(profile.getByTestId('profile-execution-model')).toHaveText('claude-sonnet-4-6');
  await expect(profile.getByTestId('profile-other-models')).toHaveText('claude-haiku-4-5');

  const warning = page.getByTestId('run-warnings').locator('[data-code="ambient-user-config"]');
  await expect(warning).toContainText('ambient-user-config: 2/2 agent runs');
  await expect(warning).toContainText('May include user-level instructions');

  const [baseline, candidate] = [
    page.getByTestId('agent-run').nth(0),
    page.getByTestId('agent-run').nth(1),
  ];
  await expect(baseline.locator('summary').first()).toContainText('Baseline (v1)');
  await expect(baseline.getByTestId('skill-invoked')).toHaveText('Skill invoked (1)');
  await expect(candidate.locator('summary').first()).toContainText('Candidate (v2)');
  await expect(candidate.getByTestId('skill-invoked')).toHaveText('Skill not invoked');

  await baseline.locator('summary').first().click();
  await expect(baseline.getByTestId('agent-run-usage')).toHaveText(
    'Tokens: 1,234 in / 56 out · Cost: n/a (subscription) · Tool calls: 1 · Permission denials: 1 · Retries: 0',
  );
  await candidate.locator('summary').first().click();
  // No usage reported: never an invented number.
  await expect(candidate.getByTestId('agent-run-usage')).toContainText('Tokens: not reported');

  const sections = candidate.getByRole('row', { name: /structure/ });
  await expect(sections.getByTestId('assertion-details')).toContainText('MissingRisks');
  await expect(sections.getByTestId('assertion-details')).toContainText(
    'FoundAssumptions, Estimate',
  );
  const timeout = candidate.getByRole('row', { name: /mentions-pm/ });
  await expect(timeout.getByText('error', { exact: true })).toBeVisible();
  await expect(timeout.getByTestId('assertion-details')).toContainText(
    'pattern-timeout: Pattern evaluation exceeded 2000 ms',
  );
  await expect(timeout.getByTestId('assertion-details')).toContainText('/(a+)+$/');
  // Agent-written HTML is shown as text, never rendered.
  const table = candidate.getByRole('row', { name: /hours/ });
  await expect(table.getByTestId('assertion-details')).toContainText('Cell<b>bold</b>');
  await expect(table.getByTestId('assertion-details')).toContainText('Valueno number');
  await expect(candidate.locator('b')).toHaveCount(0);

  await page.goto(`/results/${RUN.v1None}`);
  await expect(page.getByTestId('run-variants')).toHaveText(
    'Baseline (no artifact) vs Candidate (v1)',
  );
  await expect(page.getByTestId('baseline-score-label')).toHaveText('Baseline (no artifact)');
});

test('the suite of the seeded runs has no Run button and shows the CLI command (FR-118-53)', async ({
  page,
}) => {
  await page.goto(`/benchmarks/${SUITE}`);
  await expect(page.getByTestId('run-from-cli')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run' })).toHaveCount(0);
});

test('an artifact without runs shows the planned benchmark init command', async ({ page }) => {
  await withDatabase((db) => deleteRuns(db));
  try {
    await page.goto(`/artifacts/${ARTIFACT}?tab=evaluations`);
    const empty = page.getByTestId('no-runs');
    await expect(empty).toContainText(
      'No benchmark runs yet. Create a suite with directivebench benchmark init --artifact e2e98-doc-skill',
    );
    await expect(empty).toContainText('Planned — the command is not implemented yet');
    await expect(page.getByTestId('version-results')).toHaveCount(0);
  } finally {
    await withDatabase(reseed);
  }
});
