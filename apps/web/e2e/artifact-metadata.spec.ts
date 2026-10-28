import { expect, test, type Page } from '@playwright/test';
import { DEMO_ARTIFACT, DEMO_SUITE, withDatabase } from './support';

// Issue #64: tags, notes and suite assignments are edited on the artifact detail page
// (SPEC-101 §11). The test leaves the demo artifact as it found it, because other spec files
// share the database: no tags, no notes and the demo suite assigned.

async function demoArtifactId(): Promise<string> {
  return withDatabase((db) => {
    const row = db.prepare('select id from artifacts where slug = ?').get(DEMO_ARTIFACT) as
      { id: string } | undefined;
    if (!row) throw new Error('The demo data directory has no demo artifact');
    return row.id;
  });
}

function card(page: Page, title: string) {
  return page.locator('[data-slot="card"]').filter({
    has: page.getByRole('heading', { level: 2, name: title, exact: true }),
  });
}

test('tags are added and removed on the artifact Overview', async ({ page }) => {
  await page.goto(`/artifacts/${await demoArtifactId()}`);
  const tags = card(page, 'Tags');
  await expect(tags.getByText('No tags yet.')).toBeVisible();
  const field = tags.getByRole('textbox', { name: 'Tag' });

  // Enter submits; the tag is trimmed and lower-cased, and the field is ready for the next one.
  await field.fill('  Security ');
  await field.press('Enter');
  await expect(tags.getByRole('status')).toHaveText('Added tag security.');
  await expect(tags.getByRole('list', { name: 'Tags' })).toHaveText(/security/);
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();

  await field.fill('review');
  await tags.getByRole('button', { name: 'Add tag' }).click();
  await expect(tags.getByRole('status')).toHaveText('Added tag review.');

  // An invalid tag stays in the field, which is marked, described and focused.
  await field.fill('a, b');
  await field.press('Enter');
  await expect(tags.getByRole('alert')).toHaveText(
    'A tag cannot contain a comma. Add each tag on its own.',
  );
  await expect(field).toHaveValue('a, b');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(/cannot contain a comma/);
  await expect(field).toBeFocused();

  // Remove names its tag; afterwards the focus returns to the field.
  await tags.getByRole('button', { name: 'Remove tag security' }).click();
  await expect(tags.getByRole('status')).toHaveText('Removed tag security.');
  await expect(tags.getByRole('button', { name: 'Remove tag security' })).toHaveCount(0);
  await expect(field).toBeFocused();

  // Saved: a reload shows the stored tag.
  await page.reload();
  await expect(card(page, 'Tags').getByRole('list', { name: 'Tags' })).toHaveText(/review/);
  await card(page, 'Tags').getByRole('button', { name: 'Remove tag review' }).click();
  await expect(card(page, 'Tags').getByText('No tags yet.')).toBeVisible();
});

test('notes keep their line breaks and can be cleared', async ({ page }) => {
  const artifactId = await demoArtifactId();
  await page.goto(`/artifacts/${artifactId}`);
  const notes = card(page, 'Notes');
  const field = notes.getByRole('textbox', { name: 'Notes' });
  await expect(field).toHaveValue('');

  await field.fill('Compare with v1.\nKeep it short.');
  await notes.getByRole('button', { name: 'Save notes' }).click();
  await expect(notes.getByRole('status')).toHaveText('Saved the notes.');
  const stored = await withDatabase(
    (db) =>
      (db.prepare('select notes from artifacts where id = ?').get(artifactId) as { notes: string })
        .notes,
  );
  expect(stored).toBe('Compare with v1.\nKeep it short.');

  await page.reload();
  await expect(card(page, 'Notes').getByRole('textbox', { name: 'Notes' })).toHaveValue(
    'Compare with v1.\nKeep it short.',
  );
  await card(page, 'Notes').getByRole('textbox', { name: 'Notes' }).fill('');
  await card(page, 'Notes').getByRole('button', { name: 'Save notes' }).click();
  await expect(card(page, 'Notes').getByRole('status')).toHaveText('Cleared the notes.');
});

test('a benchmark suite is unassigned and assigned again on the Benchmarks tab', async ({
  page,
}) => {
  await page.goto(`/artifacts/${await demoArtifactId()}?tab=benchmarks`);
  const suites = card(page, 'Assigned benchmarks');
  await expect(suites.getByRole('link', { name: DEMO_SUITE })).toBeVisible();

  await suites.getByRole('button', { name: `Unassign suite ${DEMO_SUITE}` }).click();
  await expect(suites.getByRole('status')).toHaveText(
    `Unassigned ${DEMO_SUITE}. Its results stay in Results by version.`,
  );
  await expect(suites.getByText('No benchmark suite is assigned.')).toBeVisible();
  const select = suites.getByRole('combobox', { name: 'Benchmark suite' });
  await expect(select).toBeFocused();
  await expect(select).toHaveValue(/.+/);

  await suites.getByRole('button', { name: 'Assign' }).click();
  await expect(suites.getByRole('status')).toHaveText(
    `Assigned ${DEMO_SUITE}. Run it from its suite page.`,
  );
  await expect(suites.getByRole('link', { name: DEMO_SUITE })).toHaveAttribute(
    'href',
    /^\/benchmarks\//,
  );
});

test('the editing cards fit a 320px screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/artifacts/${await demoArtifactId()}`);
  await expect(card(page, 'Tags').getByRole('button', { name: 'Add tag' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});
