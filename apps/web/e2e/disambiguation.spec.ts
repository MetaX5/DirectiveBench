import { expect, test, type Locator, type Page } from '@playwright/test';
import type { DatabaseSync } from 'node:sqlite';
import {
  CLASH_CATEGORY_NAME,
  CLASH_CATEGORY_SLUGS,
  COPY_SUITE_SLUG,
  DEMO_SUITE_SLUG,
  TWIN_ARTIFACT_SLUG,
  idOf,
  removeArtifactTwin,
  removeChipClash,
  removeSuiteCopy,
  seedArtifactTwin,
  seedChipClash,
  seedSuiteCopy,
} from './disambiguation-seed';
import {
  DEMO_ARTIFACT,
  DEMO_SUITE,
  demoJobPayload,
  demoRunId,
  escapeRegExp,
  withDatabase,
} from './support';

// Issues 227 and 228 (decisions K1 to K9, approved 2026-11-16): same-named suites, archived
// categories and artifacts are told apart by their ID or slug, and per-row controls have unique
// accessible names. Every test seeds its clash and removes it again, because all spec files
// share one database (lesson 2026-11-10).

/** The accessible names of the controls a locator matches, in order. */
async function names(controls: Locator): Promise<string[]> {
  const count = await controls.count();
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    result.push(
      await control.evaluate(
        (el) => el.getAttribute('aria-label') ?? (el as HTMLElement).innerText.trim(),
      ),
    );
  }
  return result;
}

function card(page: Page, title: string) {
  return page.locator('[data-slot="card"]').filter({
    has: page.getByRole('heading', { level: 2, name: title, exact: true }),
  });
}

test.describe('same-named suites (issue 227, K1 to K4)', () => {
  test.beforeEach(() => withDatabase(seedSuiteCopy));
  test.afterEach(() => withDatabase(removeSuiteCopy));

  test('the suite list always shows each ID and names clashing links uniquely (K1)', async ({
    page,
  }) => {
    await page.goto('/benchmarks');
    const rows = page.getByRole('row').filter({ hasText: DEMO_SUITE });
    await expect(rows).toHaveCount(2);
    // The ID line under the name is read as "ID <id>" (the label is for screen readers).
    expect((await rows.getByTestId('suite-id').allTextContents()).sort()).toEqual([
      `ID ${DEMO_SUITE_SLUG}`,
      `ID ${COPY_SUITE_SLUG}`,
    ]);
    for (const slug of [DEMO_SUITE_SLUG, COPY_SUITE_SLUG]) {
      const link = page.getByRole('link', { name: `${DEMO_SUITE}, ID ${slug}`, exact: true });
      await expect(link).toHaveCount(1);
      // The visible text stays the name.
      await expect(link).toHaveText(DEMO_SUITE);
    }
  });

  test('the suite page shows its ID under the title (K2)', async ({ page }) => {
    const id = await withDatabase((db) => idOf(db, 'benchmark_suites', COPY_SUITE_SLUG));
    await page.goto(`/benchmarks/${id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(DEMO_SUITE);
    await expect(page.getByTestId('suite-id')).toHaveText(COPY_SUITE_SLUG);
    await expect(page.getByText(`ID ${COPY_SUITE_SLUG}`, { exact: true })).toBeVisible();
  });

  test('the artifact page shows every assigned suite ID and the runs table only on a clash (K3, K4)', async ({
    page,
  }) => {
    const artifactId = await withDatabase((db) => idOf(db, 'artifacts', DEMO_ARTIFACT));
    await page.goto(`/artifacts/${artifactId}?tab=benchmarks`);
    const assigned = card(page, 'Assigned benchmarks').getByRole('list', {
      name: 'Assigned suites',
    });
    await expect(assigned.getByRole('listitem').first()).toContainText(
      `${DEMO_SUITE}, ID ${DEMO_SUITE_SLUG}`,
    );
    // The name is shared now, so the link adds the ID too.
    await expect(
      assigned.getByRole('link', { name: `${DEMO_SUITE}, ID ${DEMO_SUITE_SLUG}`, exact: true }),
    ).toHaveCount(1);

    await page.goto(`/artifacts/${artifactId}?tab=evaluations`);
    const run = page.getByTestId('version-run').first();
    await expect(run.getByTestId('suite-id')).toHaveText(`, ID ${DEMO_SUITE_SLUG}`);
    await expect(
      run.getByRole('link', { name: `${DEMO_SUITE}, ID ${DEMO_SUITE_SLUG}`, exact: true }),
    ).toBeVisible();

    // Without the copy the name is unique again: no ID in the table, the link is the name.
    await withDatabase(removeSuiteCopy);
    await page.reload();
    await expect(page.getByTestId('version-run').first().getByTestId('suite-id')).toHaveCount(0);
    await expect(
      page.getByTestId('version-run').first().getByRole('link', { name: DEMO_SUITE, exact: true }),
    ).toBeVisible();
  });

  test('Results and Executions add the ID on a clash, the run page always (K4)', async ({
    page,
  }) => {
    await page.goto('/results');
    const result = page.getByRole('row').filter({ hasText: DEMO_ARTIFACT }).first();
    await expect(result.getByTestId('suite-id')).toHaveText(`, ID ${DEMO_SUITE_SLUG}`);

    await page.goto('/executions');
    const job = page.getByRole('row').filter({ hasText: DEMO_SUITE }).first();
    await expect(job.getByTestId('suite-id')).toHaveText(`, ID ${DEMO_SUITE_SLUG}`);

    await withDatabase(removeSuiteCopy);
    await page.goto('/results');
    await expect(page.getByTestId('suite-id')).toHaveCount(0);
    await page.goto('/executions');
    await expect(page.getByTestId('suite-id')).toHaveCount(0);
    // The run page's Suite version fact shows the ID with or without a clash.
    await page.goto('/results');
    await page
      .getByRole('row')
      .filter({ hasText: DEMO_ARTIFACT })
      .first()
      .getByRole('link')
      .click();
    await expect(page.getByTestId('suite-id')).toHaveText(`, ID ${DEMO_SUITE_SLUG}`);
  });

  test('a long suite ID without hyphens wraps inside the run facts at 320px (K4, QA finding)', async ({
    page,
  }) => {
    // Suite IDs may be 80 characters with no hyphen (the definition schema); found by the
    // browser QA agent on PR 234, where the ID left the "Environment and versions" card.
    const longSlug = 'a'.repeat(80);
    const runId = await withDatabase((db) => {
      db.prepare('update benchmark_suites set slug = ? where slug = ?').run(
        longSlug,
        DEMO_SUITE_SLUG,
      );
      return demoRunId(db);
    });
    try {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`/results/${runId}`);
      const id = page.getByTestId('suite-id');
      await expect(id).toHaveText(`, ID ${longSlug}`);
      const facts = id.locator('xpath=ancestor::dl[1]');
      const idBox = (await id.boundingBox())!;
      const factsBox = (await facts.boundingBox())!;
      expect(idBox.x + idBox.width).toBeLessThanOrEqual(factsBox.x + factsBox.width + 0.5);
    } finally {
      await withDatabase((db) =>
        db
          .prepare('update benchmark_suites set slug = ? where slug = ?')
          .run(DEMO_SUITE_SLUG, longSlug),
      );
    }
  });
});

test('archived categories with one chip text show their slug on the chips (issue 227, K5)', async ({
  page,
}) => {
  const artifactId = await withDatabase((db) => {
    seedChipClash(db);
    return idOf(db, 'artifacts', DEMO_ARTIFACT);
  });
  try {
    const chips = CLASH_CATEGORY_SLUGS.map(
      (slug) => `${CLASH_CATEGORY_NAME} (archived), slug ${slug}`,
    );
    await page.goto('/artifacts');
    const row = page.locator(`tr[data-artifact-id="${artifactId}"]`);
    await expect(row.getByTestId('category-slug')).toHaveText(chips);

    await page.goto(`/artifacts/${artifactId}`);
    const list = card(page, 'Categories').getByRole('list', { name: 'Categories' });
    await expect(list.getByTestId('category-slug')).toHaveText(
      CLASH_CATEGORY_SLUGS.map((slug) => `, slug ${slug}`),
    );
    // Each chip's text is what its Remove name says after "Remove category ".
    for (const chip of chips) {
      // The item's text is the chip, then its Remove button's visible text.
      const item = list
        .getByRole('listitem')
        .filter({ hasText: new RegExp(`^${escapeRegExp(chip)}Remove$`) });
      await expect(item).toHaveCount(1);
      await expect(item.getByRole('button')).toHaveAccessibleName(`Remove category ${chip}`);
    }
    // At 320px the chip wraps inside the card instead of widening the page.
    await page.setViewportSize({ width: 320, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await withDatabase(removeChipClash);
  }
});

test('the suite page Run card names each Run and shows the slug of a same-named artifact (issues 227, 228, K7, K9)', async ({
  page,
}) => {
  const suiteId = await withDatabase((db) => {
    seedArtifactTwin(db);
    return idOf(db, 'benchmark_suites', DEMO_SUITE_SLUG);
  });
  try {
    await page.goto(`/benchmarks/${suiteId}`);
    const run = card(page, 'Run benchmark');
    const buttons = run.getByRole('button');
    await expect(buttons).toHaveCount(2);
    // The visible text stays "Run"; the names differ by the unique slug (K7).
    await expect(buttons).toHaveText(['Run', 'Run']);
    expect((await names(buttons)).sort()).toEqual(
      [DEMO_ARTIFACT, TWIN_ARTIFACT_SLUG].map((slug) => `Run on ${DEMO_ARTIFACT}, slug ${slug}`),
    );
    // Both names are shared, so both rows show their slug and their links add it (K9).
    await expect(run.getByTestId('artifact-slug')).toHaveCount(2);
    expect((await run.getByTestId('artifact-slug').allTextContents()).sort()).toEqual([
      `, slug ${DEMO_ARTIFACT}`,
      `, slug ${TWIN_ARTIFACT_SLUG}`,
    ]);
    for (const slug of [DEMO_ARTIFACT, TWIN_ARTIFACT_SLUG]) {
      await expect(
        run.getByRole('link', { name: `${DEMO_ARTIFACT}, slug ${slug}`, exact: true }),
      ).toHaveCount(1);
    }

    // The link is underlined at rest, so it is told apart from the muted slug after it without
    // colour (WCAG 1.4.1; dark theme link and slug are 2.48:1; browser QA finding F1 of PR 238).
    for (const link of await run.getByRole('link').all()) {
      expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe(
        'underline',
      );
    }

    // Alone with its name the artifact shows no slug, and its Run is still named for it.
    await withDatabase(removeArtifactTwin);
    await page.reload();
    await expect(run.getByTestId('artifact-slug')).toHaveCount(0);
    await expect(run.getByRole('button')).toHaveAccessibleName(
      `Run on ${DEMO_ARTIFACT}, slug ${DEMO_ARTIFACT}`,
    );
  } finally {
    await withDatabase(removeArtifactTwin);
  }
});

test('Executions names Cancel and View run by the job ID (issue 228, K8)', async ({ page }) => {
  const jobIds = [`job_e2e228a${Date.now()}`, `job_e2e228b${Date.now()}`];
  const cleanup = (db: DatabaseSync) => {
    for (const id of jobIds) db.prepare('delete from jobs where id = ?').run(id);
    db.exec('drop trigger if exists e2e_hold_jobs_228');
  };
  await withDatabase((db) => {
    cleanup(db);
    // Hold both jobs pending: the runner cannot start them (management.spec.ts does the same).
    db.exec(
      `create trigger e2e_hold_jobs_228 before update of status on jobs
         when old.id in ('${jobIds[0]}', '${jobIds[1]}') and new.status = 'running'
         begin select raise(ignore); end`,
    );
    for (const id of jobIds) {
      db.prepare(
        `insert into jobs (id, type, status, payload, attempts, created_at)
         values (?, 'benchmark-run', 'pending', ?, 0, ?)`,
      ).run(id, JSON.stringify(demoJobPayload(db)), new Date().toISOString());
    }
  });
  try {
    await page.goto('/executions');
    for (const id of jobIds) {
      const row = page.getByRole('row').filter({ hasText: id });
      await expect(row.getByRole('button')).toHaveText('Cancel');
      await expect(row.getByRole('button')).toHaveAccessibleName(`Cancel job ${id}`);
    }
    const cancels = page.getByRole('button', { name: /^Cancel job / });
    const cancelNames = await names(cancels);
    expect(new Set(cancelNames).size).toBe(cancelNames.length);

    // The demo job's run link is named for its job.
    const viewRuns = page.getByRole('link', { name: /^View run of job job_/ });
    await expect(viewRuns.first()).toHaveText('View run');
    const linkNames = await names(viewRuns);
    expect(linkNames.length).toBeGreaterThan(0);
    expect(new Set(linkNames).size).toBe(linkNames.length);
    for (const name of linkNames) {
      const jobId = name.replace('View run of job ', '');
      await expect(page.getByRole('row').filter({ hasText: jobId })).toHaveCount(1);
    }
  } finally {
    await withDatabase(cleanup);
  }
});

test('Status links on Artifacts and Artifact links on Results have unique names (issue 227)', async ({
  page,
}) => {
  await page.goto('/artifacts');
  const status = page.getByRole('link', { name: /, latest run of / });
  await expect(status.first()).toHaveAccessibleName(
    new RegExp(
      `^(Passed|Failed|Regression|Unstable|Error|Not comparable), latest run of ${DEMO_ARTIFACT}, slug ${DEMO_ARTIFACT}$`,
    ),
  );
  const statusNames = await names(status);
  expect(new Set(statusNames).size).toBe(statusNames.length);

  await page.goto('/results');
  const runs = page.getByRole('link', { name: new RegExp(`^${DEMO_ARTIFACT}, run run_`) });
  await expect(runs.first()).toHaveText(DEMO_ARTIFACT);
  const runNames = await names(runs);
  expect(new Set(runNames).size).toBe(runNames.length);
});

test('the suite picker adds the ID when an assigned suite has the same name (issue 235, L1)', async ({
  page,
}) => {
  const artifactId = await withDatabase((db) => {
    seedSuiteCopy(db);
    return idOf(db, 'artifacts', DEMO_ARTIFACT);
  });
  try {
    await page.goto(`/artifacts/${artifactId}?tab=benchmarks`);
    const box = card(page, 'Assigned benchmarks');
    // The demo suite is assigned; its same-named copy is the only one in the picker, and the
    // option still reads with the ID, as the assigned item above it does (finding G1 of PR 234).
    await expect(
      box.getByRole('list', { name: 'Assigned suites' }).getByRole('listitem').first(),
    ).toContainText(`${DEMO_SUITE}, ID ${DEMO_SUITE_SLUG}`);
    const picker = box.locator('select[name="suiteId"]');
    const options = await picker.locator('option').allTextContents();
    expect(options).toContain(`${DEMO_SUITE}, ID ${COPY_SUITE_SLUG}`);
    expect(options).not.toContain(DEMO_SUITE);
  } finally {
    await withDatabase(removeSuiteCopy);
  }
});

test.describe('same-named artifacts (issue 236, L2 to L7)', () => {
  test.beforeEach(() => withDatabase(seedArtifactTwin));
  test.afterEach(() => withDatabase(removeArtifactTwin));

  const demoName = `${DEMO_ARTIFACT}, slug ${DEMO_ARTIFACT}`;

  test('Artifacts shows the slug of each same-named artifact and names its link (L2, L7)', async ({
    page,
  }) => {
    await page.goto('/artifacts');
    for (const slug of [DEMO_ARTIFACT, TWIN_ARTIFACT_SLUG]) {
      const link = page.getByRole('link', { name: `${DEMO_ARTIFACT}, slug ${slug}`, exact: true });
      await expect(link).toHaveCount(1);
      await expect(link).toHaveText(DEMO_ARTIFACT);
      const row = page.getByRole('row').filter({ has: link });
      await expect(row.getByTestId('artifact-slug')).toHaveText(`, slug ${slug}`);
    }
    // At 320px the slug wraps inside the table, the page does not scroll sideways.
    await page.setViewportSize({ width: 320, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // Alone with its name the artifact shows no slug and its link is its name.
    await withDatabase(removeArtifactTwin);
    await page.reload();
    await expect(page.getByTestId('artifact-slug')).toHaveCount(0);
    await expect(page.getByRole('link', { name: DEMO_ARTIFACT, exact: true })).toHaveCount(1);
  });

  test('Results, Executions and the suite Runs table add the slug on a clash (L3, L4, L5, L7)', async ({
    page,
  }) => {
    const suiteId = await withDatabase((db) => idOf(db, 'benchmark_suites', DEMO_SUITE_SLUG));
    const runId = await withDatabase(demoRunId);

    await page.goto('/results');
    const result = page.getByRole('link', {
      name: `${demoName}, run ${runId}`,
      exact: true,
    });
    await expect(result).toHaveText(DEMO_ARTIFACT);
    await expect(
      page.getByRole('row').filter({ has: result }).getByTestId('artifact-slug'),
    ).toHaveText(`, slug ${DEMO_ARTIFACT}`);

    await page.goto('/executions');
    const job = page.getByRole('row').filter({ hasText: DEMO_SUITE }).first();
    await expect(job.getByTestId('artifact-slug')).toHaveText(`, slug ${DEMO_ARTIFACT}`);

    await page.goto(`/benchmarks/${suiteId}`);
    const runs = card(page, 'Runs').getByRole('row').filter({ hasText: runId });
    await expect(runs.getByTestId('artifact-slug')).toHaveText(`, slug ${DEMO_ARTIFACT}`);

    // Without the twin: no slug anywhere, and the Results link keeps its old name.
    await withDatabase(removeArtifactTwin);
    await page.goto('/results');
    await expect(page.getByTestId('artifact-slug')).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: `${DEMO_ARTIFACT}, run ${runId}`, exact: true }),
    ).toHaveCount(1);
    await page.goto('/executions');
    await expect(page.getByTestId('artifact-slug')).toHaveCount(0);
    await page.goto(`/benchmarks/${suiteId}`);
    await expect(card(page, 'Runs').getByTestId('artifact-slug')).toHaveCount(0);
  });

  test('the run page always shows the artifact slug and labels both hashes (L6)', async ({
    page,
  }) => {
    const runId = await withDatabase((db) => {
      removeArtifactTwin(db);
      return demoRunId(db);
    });
    await page.goto(`/results/${runId}`);
    const facts = card(page, 'Environment and versions');
    // No clash: the fact shows the slug anyway; the title stays the name.
    await expect(facts.getByTestId('artifact-slug')).toHaveText(`, slug ${DEMO_ARTIFACT}`);
    await expect(facts.getByTestId('content-hash')).toHaveText([
      /^hash [0-9a-f]{12}…$/,
      /^hash [0-9a-f]{12}…$/,
    ]);
    await expect(facts.getByRole('link', { name: /^validate-external-input v\d+$/ })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
