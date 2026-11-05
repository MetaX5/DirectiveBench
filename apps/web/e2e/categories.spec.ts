import { expect, test, type Page } from '@playwright/test';
import { DEMO_ARTIFACT, count, withDatabase } from './support';

// SPEC-124 Phase 2: create, rename, archive (after a confirmation) and unarchive categories on
// `/categories` and `/categories/[slug]`, archived chips and the archived filter option. Other
// spec files share the database, so every category made here is deleted again afterwards.

const created: string[] = [];

test.afterEach(async () => {
  await withDatabase((db) => {
    for (const slug of created.splice(0)) {
      db.prepare(
        'delete from artifact_categories where category_id in (select id from categories where slug = ?)',
      ).run(slug);
      db.prepare('delete from categories where slug = ?').run(slug);
    }
  });
});

function card(page: Page, title: string) {
  return page.locator('[data-slot="card"]').filter({
    has: page.getByRole('heading', { level: 2, name: title, exact: true }),
  });
}

function table(page: Page, name: 'Active categories' | 'Archived categories') {
  return page.getByRole('region', { name });
}

async function slugOf(name: string): Promise<string> {
  return withDatabase((db) => {
    const row = db.prepare('select slug from categories where name = ?').get(name) as
      { slug: string } | undefined;
    if (!row) throw new Error(`No category named ${name}`);
    return row.slug;
  });
}

/** Creates a category through the New category card and remembers it for clean-up. */
async function createCategory(page: Page, name: string, description = ''): Promise<string> {
  await page.goto('/categories');
  const form = card(page, 'New category');
  await form.getByRole('textbox', { name: 'Name' }).fill(name);
  await form.getByRole('textbox', { name: 'Description (optional)' }).fill(description);
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(form.getByRole('status')).toHaveText(`Created ${name}.`);
  const slug = await slugOf(name);
  created.push(slug);
  return slug;
}

/** Assigns a category to the demo artifact (setup only: assignment in the UI is Phase 3). */
async function assignToDemoArtifact(slug: string): Promise<void> {
  await withDatabase((db) =>
    db
      .prepare(
        `insert into artifact_categories (artifact_id, category_id, created_at)
         select a.id, c.id, ? from artifacts a, categories c where a.slug = ? and c.slug = ?`,
      )
      .run(new Date().toISOString(), DEMO_ARTIFACT, slug),
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('a created category appears in the Active table and the Artifacts filter', async ({
  page,
}) => {
  await page.goto('/categories');
  await expect(page.getByText(/^Group artifacts in your own categories\./)).toBeVisible();
  const form = card(page, 'New category');
  const name = form.getByRole('textbox', { name: 'Name' });
  const description = form.getByRole('textbox', { name: 'Description (optional)' });
  // The inline Create button matches the inputs' height (AGENTS.md §7).
  const button = form.getByRole('button', { name: 'Create' });
  expect((await button.boundingBox())?.height).toBe((await name.boundingBox())?.height);

  await name.fill('  Estimation   E2E ');
  await description.fill('Skills that estimate work.');
  await name.press('Enter');
  await expect(form.getByRole('status')).toHaveText('Created Estimation E2E.');
  created.push('estimation-e2e');
  // Focus returns to the cleared Name field (§11.2 focus map).
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('');
  await expect(description).toHaveValue('');

  const row = table(page, 'Active categories').getByRole('row', { name: /^Estimation E2E / });
  await expect(row).toContainText('estimation-e2e');
  await expect(row).toContainText('Skills that estimate work.');
  await expect(row).toContainText('User-defined');
  // No artifact yet: a plain 0, not a link (D4).
  await expect(row.getByRole('cell').last()).toHaveText('0');
  await expect(row.getByRole('link')).toHaveCount(1);
  await expect(row.getByRole('link', { name: 'Estimation E2E' })).toHaveAttribute(
    'href',
    '/categories/estimation-e2e',
  );

  await page.goto('/artifacts');
  await expect(page.locator('select[name="category"] option[value="estimation-e2e"]')).toHaveText(
    'Estimation E2E',
  );
});

test('a duplicate, a control character or an over-long name is refused with both values kept', async ({
  page,
}) => {
  await createCategory(page, 'Duplicate E2E');
  const before = await withDatabase((db) => count(db, 'select count(*) as n from categories'));
  const form = card(page, 'New category');
  const name = form.getByRole('textbox', { name: 'Name' });
  const description = form.getByRole('textbox', { name: 'Description (optional)' });

  await name.fill(' DUPLICATE   e2e ');
  await description.fill('kept');
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'A category named Duplicate E2E already exists. Choose another name.',
  );
  await expect(name).toHaveValue(' DUPLICATE   e2e ');
  await expect(description).toHaveValue('kept');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription(/already exists/);
  await expect(name).toBeFocused();
  // The error goes away as soon as the value changes.
  await name.press('End');
  await name.press('Backspace');
  await expect(form.getByRole('alert')).toHaveCount(0);

  // A tab is a control character: refused on the raw input, before normalisation (§8.3).
  await name.fill('Tab\there');
  await name.press('Enter');
  await expect(form.getByRole('alert')).toHaveText(
    'A name cannot contain line breaks or other control characters.',
  );

  // Past the field's maxLength (a forged post): the server refuses it.
  await name.evaluate((input) => input.removeAttribute('maxlength'));
  await name.fill('n'.repeat(65));
  await name.press('Enter');
  await expect(form.getByRole('alert')).toHaveText(
    'A name can be at most 64 characters. Shorten it.',
  );

  // A description error marks the description field.
  await name.fill('Fine name');
  await description.evaluate((input) => input.removeAttribute('maxlength'));
  await description.fill('d'.repeat(501));
  await name.press('Enter');
  await expect(form.getByRole('alert')).toHaveText(
    'A description can be at most 500 characters. Shorten it.',
  );
  await expect(description).toHaveAttribute('aria-invalid', 'true');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  await expect(description).toBeFocused();
  await expect(name).toHaveValue('Fine name');

  // A name whose slug an active category holds names that category.
  await name.fill('Duplicate-E2E!');
  await description.fill('');
  await name.press('Enter');
  await expect(form.getByRole('alert')).toHaveText(
    'The name gives the link duplicate-e2e, which Duplicate E2E already uses. Choose another name.',
  );
  expect(await withDatabase((db) => count(db, 'select count(*) as n from categories'))).toBe(
    before,
  );
});

test('a rename keeps the slug and the filtered Artifacts link', async ({ page }) => {
  const slug = await createCategory(page, 'Rename E2E', 'First');
  await assignToDemoArtifact(slug);
  await table(page, 'Active categories').getByRole('link', { name: 'Rename E2E' }).click();
  await expect(page).toHaveURL(`/categories/${slug}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Rename E2E' })).toBeVisible();
  await expect(page.getByText(`Slug ${slug}. User-defined.`)).toBeVisible();
  await expect(card(page, 'Artifacts')).toContainText('1 artifact has this category.');

  const details = card(page, 'Details');
  await expect(details).toContainText(`The slug stays ${slug}, so links`);
  const name = details.getByRole('textbox', { name: 'Name' });
  const description = details.getByRole('textbox', { name: 'Description (optional)' });
  const save = details.getByRole('button', { name: 'Save' });
  expect((await save.boundingBox())?.height).toBe((await name.boundingBox())?.height);
  await expect(name).toHaveValue('Rename E2E');
  await expect(description).toHaveValue('First');

  await name.fill('Renamed E2E');
  await save.click();
  await expect(details.getByRole('status')).toHaveText(
    `Renamed to Renamed E2E. Its slug stays ${slug}, so links keep working.`,
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Renamed E2E' })).toBeVisible();
  await expect(name).toHaveValue('Renamed E2E');
  await expect(name).toBeFocused();

  await description.fill('Second');
  await save.click();
  await expect(details.getByRole('status')).toHaveText('Saved.');
  await save.click();
  await expect(details.getByRole('status')).toHaveText('Nothing changed.');
  await expect(description).toHaveValue('Second');

  // The old link still filters to the same artifact, now under the new name.
  await card(page, 'Artifacts').getByRole('link', { name: '1 artifact' }).click();
  await expect(page).toHaveURL(`/artifacts?category=${slug}`);
  await expect(page.locator('select[name="category"]')).toHaveValue(slug);
  await expect(page.locator('select[name="category"] option:checked')).toHaveText('Renamed E2E');
  await expect(page.getByRole('link', { name: DEMO_ARTIFACT })).toBeVisible();
});

test('archive asks first with the count, Cancel writes nothing, unarchive needs no panel', async ({
  page,
}) => {
  const slug = await createCategory(page, 'Archive E2E');
  await assignToDemoArtifact(slug);
  await page.goto(`/categories/${slug}`);
  const status = card(page, 'Status');
  await expect(status).toContainText(
    'Archived categories leave pickers and filters. Their assignments stay.',
  );
  const archive = status.getByRole('button', { name: 'Archive', exact: true });
  await expect(archive).toHaveAttribute('aria-expanded', 'false');

  // Archive opens the panel and moves the focus to its question.
  await archive.click();
  const panel = status.getByRole('alert');
  await expect(archive).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByText('Archive Archive E2E?')).toBeFocused();
  await expect(panel).toContainText(
    'It leaves pickers, filters and the bulk form. It stays on 1 artifact, shown as archived.',
  );
  const confirm = panel.getByRole('button', { name: 'Archive Archive E2E' });
  const cancel = panel.getByRole('button', { name: 'Cancel' });
  expect((await cancel.boundingBox())?.height).toBe((await confirm.boundingBox())?.height);

  // Cancel closes it, writes nothing, shows no status line and returns the focus.
  await cancel.click();
  await expect(panel).toHaveCount(0);
  await expect(archive).toBeFocused();
  await expect(archive).toHaveAttribute('aria-expanded', 'false');
  await expect(status.locator('[role="status"]')).toHaveText('');
  expect(
    await withDatabase((db) =>
      count(
        db,
        'select count(*) as n from categories where slug = ? and archived_at is null',
        slug,
      ),
    ),
  ).toBe(1);

  // Pressing Archive again toggles the panel closed.
  await archive.click();
  await archive.click();
  await expect(status.getByRole('alert')).toHaveCount(0);

  await archive.click();
  await status.getByRole('button', { name: 'Archive Archive E2E' }).click();
  await expect(status.getByRole('status')).toHaveText(
    'Archived Archive E2E. It stays on 1 artifact.',
  );
  const unarchive = status.getByRole('button', { name: 'Unarchive' });
  await expect(unarchive).toBeFocused();
  await expect(status).toContainText('Archived. It stays on 1 artifact.');
  await expect(page.getByText(`archived Slug ${slug}. User-defined.`)).toBeVisible();

  // Archived: in the Archived card, out of the filter, a muted chip on the artifact.
  await page.goto('/categories');
  await expect(
    table(page, 'Archived categories').getByRole('row', { name: /^Archive E2E / }),
  ).toBeVisible();
  await expect(
    table(page, 'Active categories').getByRole('row', { name: /^Archive E2E / }),
  ).toHaveCount(0);
  await page.goto('/artifacts');
  await expect(page.locator(`select[name="category"] option[value="${slug}"]`)).toHaveCount(0);
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: DEMO_ARTIFACT }) });
  const chip = row.getByText('Archive E2E (archived)');
  await expect(chip).toHaveAttribute('data-variant', 'muted');
  // Archived chips come after the active ones (FR-124-14).
  await expect(row.locator('[data-slot="badge"][data-variant="muted"]').last()).toHaveText(
    'Archive E2E (archived)',
  );
  await row.getByRole('link', { name: DEMO_ARTIFACT }).click();
  await expect(page.getByText('Archive E2E (archived)')).toHaveAttribute('data-variant', 'muted');

  // Filtering by the archived slug still works, and the filter shows it selected, last (D12).
  await page.goto(`/artifacts?category=${slug}`);
  await expect(page.locator('select[name="category"]')).toHaveValue(slug);
  await expect(page.locator('select[name="category"] option').last()).toHaveText(
    'Archive E2E (archived)',
  );
  await expect(page.getByRole('link', { name: DEMO_ARTIFACT })).toBeVisible();

  // Unarchive without a panel; the focus goes to Archive.
  await page.goto(`/categories/${slug}`);
  await card(page, 'Status').getByRole('button', { name: 'Unarchive' }).click();
  await expect(card(page, 'Status').getByRole('status')).toHaveText(
    'Unarchived Archive E2E. It is back in pickers and filters.',
  );
  await expect(
    card(page, 'Status').getByRole('button', { name: 'Archive', exact: true }),
  ).toBeFocused();
  await page.goto('/artifacts');
  await expect(page.locator(`select[name="category"] option[value="${slug}"]`)).toHaveText(
    'Archive E2E',
  );
});

test('unarchive is refused while an active category has the same name', async ({ page }) => {
  const slug = await createCategory(page, 'Clash E2E');
  await page.goto(`/categories/${slug}`);
  await card(page, 'Status').getByRole('button', { name: 'Archive', exact: true }).click();
  await card(page, 'Status').getByRole('button', { name: 'Archive Clash E2E' }).click();
  await expect(card(page, 'Status').getByRole('status')).toHaveText('Archived Clash E2E.');
  // The archived name is free for another category, under another slug (A10).
  const other = await createCategory(page, 'Other E2E');
  await page.goto(`/categories/${other}`);
  await card(page, 'Details').getByRole('textbox', { name: 'Name' }).fill('clash e2e');
  await card(page, 'Details').getByRole('button', { name: 'Save' }).click();
  await expect(card(page, 'Details').getByRole('status')).toHaveText(/^Renamed to clash e2e\./);

  await page.goto(`/categories/${slug}`);
  const unarchive = card(page, 'Status').getByRole('button', { name: 'Unarchive' });
  await unarchive.click();
  await expect(card(page, 'Status').getByRole('alert')).toHaveText(
    'An active category is already named clash e2e. Rename one of them first.',
  );
  await expect(unarchive).toBeFocused();
});

test('an invalid or unknown slug shows the not-found page', async ({ page }) => {
  for (const path of [
    '/categories/Bad_Slug',
    '/categories/no-such-category',
    `/categories/${'a'.repeat(65)}`,
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: 'Not found' }), path).toBeVisible();
  }
});

test('create and archive work by keyboard alone', async ({ page }) => {
  await page.goto('/categories');
  const form = card(page, 'New category');
  const name = form.getByRole('textbox', { name: 'Name' });
  await name.focus();
  await page.keyboard.type('Keyboard E2E');
  await page.keyboard.press('Tab');
  await expect(form.getByRole('textbox', { name: 'Description (optional)' })).toBeFocused();
  await page.keyboard.type('Typed');
  await page.keyboard.press('Tab');
  await expect(form.getByRole('button', { name: 'Create' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(form.getByRole('status')).toHaveText('Created Keyboard E2E.');
  created.push('keyboard-e2e');
  await expect(name).toBeFocused();

  await page.goto('/categories/keyboard-e2e');
  const status = card(page, 'Status');
  const archive = status.getByRole('button', { name: 'Archive', exact: true });
  await archive.focus();
  await page.keyboard.press('Enter');
  await expect(status.getByText('Archive Keyboard E2E?')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(status.getByRole('button', { name: 'Archive Keyboard E2E' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(status.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(archive).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(status.getByRole('status')).toHaveText('Archived Keyboard E2E.');
  await expect(status.getByRole('button', { name: 'Unarchive' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(status.getByRole('status')).toHaveText(/^Unarchived Keyboard E2E\./);
  await expect(archive).toBeFocused();
});

test('the pages fit a 320px screen with a 64-character name', async ({ page }) => {
  const long = 'Q'.repeat(64);
  const slug = await createCategory(page, long, 'd'.repeat(120));
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/categories');
  await expect(table(page, 'Active categories').getByRole('link', { name: long })).toBeAttached();
  expect(await horizontalOverflow(page)).toBe(0);

  await page.goto(`/categories/${slug}`);
  await expect(card(page, 'Details').getByRole('button', { name: 'Save' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
  const status = card(page, 'Status');
  await status.getByRole('button', { name: 'Archive', exact: true }).click();
  const confirm = status.getByRole('button', { name: `Archive ${long}` });
  await expect(confirm).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
  // The confirming button stays inside the panel.
  const button = await confirm.boundingBox();
  const panel = await status.getByRole('alert').boundingBox();
  expect((button?.x ?? Infinity) + (button?.width ?? 0)).toBeLessThanOrEqual(
    (panel?.x ?? 0) + (panel?.width ?? 0),
  );
});
