import { expect, test, type Page } from '@playwright/test';
import { scanTextContrast } from './contrast';
import { DEMO_ARTIFACT, count, withDatabase } from './support';

// SPEC-124 Phase 2: create, rename, archive (after a confirmation) and unarchive categories on
// `/categories` and `/categories/[slug]`, archived chips and the archived filter option. Phase 3:
// assign and remove categories in the artifact page's Categories card (§11.3). Other spec files
// share the database, so every category made here is deleted again afterwards, and a test that
// changes the demo artifact's own categories restores them.

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

/** Assigns a category to the demo artifact (setup only, or a change from another tab). */
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

  // Renaming the archived one resolves the clash: the refusal does not stay on screen.
  await card(page, 'Details').getByRole('textbox', { name: 'Name' }).fill('Clash E2E old');
  await card(page, 'Details').getByRole('button', { name: 'Save' }).click();
  await expect(card(page, 'Details').getByRole('status')).toHaveText(/^Renamed to Clash E2E old\./);
  await expect(card(page, 'Status').getByRole('alert')).toHaveCount(0);
  await card(page, 'Status').getByRole('button', { name: 'Unarchive' }).click();
  await expect(card(page, 'Status').getByRole('status')).toHaveText(
    'Unarchived Clash E2E old. It is back in pickers and filters.',
  );
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

test('with every category archived, the Active table gives way to an empty state', async ({
  page,
}) => {
  // Setup only: archive every active category for this test, then restore exactly those.
  const archivedHere = await withDatabase((db) => {
    const ids = (
      db.prepare('select id from categories where archived_at is null').all() as { id: string }[]
    ).map((row) => row.id);
    const archive = db.prepare('update categories set archived_at = ? where id = ?');
    for (const id of ids) archive.run(new Date().toISOString(), id);
    return ids;
  });
  try {
    await page.goto('/categories');
    await expect(page.getByText('No active categories', { exact: true })).toBeVisible();
    await expect(page.getByText('Create one above, or unarchive one below.')).toBeVisible();
    await expect(table(page, 'Active categories')).toHaveCount(0);
    await expect(
      table(page, 'Archived categories').getByRole('row', { name: /^Security / }),
    ).toBeVisible();
  } finally {
    await withDatabase((db) => {
      const restore = db.prepare('update categories set archived_at = null where id = ?');
      for (const id of archivedHere) restore.run(id);
    });
  }
});

// Phase 3: the Categories card on the artifact page (SPEC-124 §11.3, D16 to D26).

async function demoArtifactId(): Promise<string> {
  return withDatabase(
    (db) =>
      (db.prepare('select id from artifacts where slug = ?').get(DEMO_ARTIFACT) as { id: string })
        .id,
  );
}

/** Archives or unarchives a category behind the page's back (another tab, or setup). */
async function setArchived(slug: string, archived: boolean): Promise<void> {
  await withDatabase((db) =>
    db
      .prepare('update categories set archived_at = ? where slug = ?')
      .run(archived ? new Date().toISOString() : null, slug),
  );
}

async function unassignFromDemoArtifact(slug: string): Promise<void> {
  await withDatabase((db) =>
    db
      .prepare(
        `delete from artifact_categories where artifact_id = (select id from artifacts where slug = ?)
         and category_id = (select id from categories where slug = ?)`,
      )
      .run(DEMO_ARTIFACT, slug),
  );
}

/**
 * Runs `body` and then restores the demo artifact's assignments and every category's archived
 * state as they were, for tests that change the demo data other spec files rely on.
 */
async function keepingDemoCategories(body: () => Promise<void>): Promise<void> {
  const saved = await withDatabase((db) => ({
    assigned: db
      .prepare(
        `select category_id as categoryId, created_at as createdAt from artifact_categories
         where artifact_id = (select id from artifacts where slug = ?)`,
      )
      .all(DEMO_ARTIFACT) as { categoryId: string; createdAt: string }[],
    archived: db.prepare('select id, archived_at as archivedAt from categories').all() as {
      id: string;
      archivedAt: string | null;
    }[],
  }));
  try {
    await body();
  } finally {
    await withDatabase((db) => {
      const artifactId = (
        db.prepare('select id from artifacts where slug = ?').get(DEMO_ARTIFACT) as { id: string }
      ).id;
      db.prepare('delete from artifact_categories where artifact_id = ?').run(artifactId);
      const insert = db.prepare(
        'insert into artifact_categories (artifact_id, category_id, created_at) values (?, ?, ?)',
      );
      for (const row of saved.assigned) insert.run(artifactId, row.categoryId, row.createdAt);
      const restore = db.prepare('update categories set archived_at = ? where id = ?');
      for (const row of saved.archived) restore.run(row.archivedAt, row.id);
    });
  }
}

function categoriesCard(page: Page) {
  return card(page, 'Categories');
}

/** The page's text, the Categories card included, has AA contrast in both themes (NFR-124-03). */
async function expectCardContrast(page: Page): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    const failures = (await scanTextContrast(page)).filter((row) => row.ratio < row.threshold);
    expect(failures, theme).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: null });
}

test('the Categories card sits after Metadata and before Tags, and Metadata keeps Compatibility', async ({
  page,
}) => {
  await page.goto(`/artifacts/${await demoArtifactId()}`);
  const titles = await page
    .locator('[data-slot="card"] h2')
    .evaluateAll((elements) => elements.map((element) => element.textContent));
  const at = titles.indexOf('Categories');
  expect(at).toBeGreaterThan(0);
  expect(titles.slice(at - 1, at + 2)).toEqual(['Metadata', 'Categories', 'Tags']);
  await expect(categoriesCard(page)).toContainText(
    'Groups for filtering the Artifacts list. A rescan keeps them.',
  );
  const metadata = card(page, 'Metadata');
  await expect(metadata).toContainText('Compatibility');
  await expect(metadata).not.toContainText('Categories');
  // The chips are not links (D18).
  await expect(
    categoriesCard(page).getByRole('list', { name: 'Categories' }).getByRole('link'),
  ).toHaveCount(0);
});

test('assign and remove on the artifact page, with the focus in the picker', async ({ page }) => {
  const slug = await createCategory(page, 'Assign E2E');
  await page.goto(`/artifacts/${await demoArtifactId()}`);
  const box = categoriesCard(page);
  const picker = box.getByRole('combobox', { name: 'Category' });
  // The first option is preselected, no placeholder (D20); the Assign button matches its height.
  const firstOption = await picker.locator('option').first().getAttribute('value');
  await expect(picker).toHaveValue(firstOption ?? '');
  const assign = box.getByRole('button', { name: 'Assign', exact: true });
  expect((await assign.boundingBox())?.height).toBe((await picker.boundingBox())?.height);

  await picker.selectOption({ label: 'Assign E2E' });
  await assign.click();
  await expect(box.getByRole('status')).toHaveText('Assigned Assign E2E.');
  await expect(picker).toBeFocused();
  const chips = box.getByRole('list', { name: 'Categories' });
  await expect(chips.getByText('Assign E2E', { exact: true })).toHaveAttribute(
    'data-variant',
    'secondary',
  );
  await expect(picker.locator('option', { hasText: 'Assign E2E' })).toHaveCount(0);
  expect(
    await withDatabase((db) =>
      count(
        db,
        `select count(*) as n from artifact_categories ac join categories c on c.id = ac.category_id
         where c.slug = ?`,
        slug,
      ),
    ),
  ).toBe(1);

  await box.getByRole('button', { name: 'Remove category Assign E2E' }).click();
  await expect(box.getByRole('status')).toHaveText('Removed Assign E2E.');
  await expect(picker).toBeFocused();
  await expect(chips.getByText('Assign E2E', { exact: true })).toHaveCount(0);
  await expect(picker.locator('option', { hasText: 'Assign E2E' })).toHaveCount(1);
});

test('a stale page reports already assigned, already removed and archived, then shows the current state', async ({
  page,
}) => {
  const slug = await createCategory(page, 'Stale E2E');
  await page.goto(`/artifacts/${await demoArtifactId()}`);
  const box = categoriesCard(page);
  const picker = box.getByRole('combobox', { name: 'Category' });

  // Assigned in another tab: a status, not an error (D24); assigned once (AC-3).
  await assignToDemoArtifact(slug);
  await picker.selectOption({ label: 'Stale E2E' });
  await box.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(box.getByRole('status')).toHaveText('Stale E2E is already assigned.');
  await expect(box.getByRole('alert')).toHaveCount(0);
  await expect(picker).toBeFocused();
  const chip = box
    .getByRole('list', { name: 'Categories' })
    .getByText('Stale E2E', { exact: true });
  await expect(chip).toHaveCount(1);
  expect(
    await withDatabase((db) =>
      count(
        db,
        `select count(*) as n from artifact_categories ac join categories c on c.id = ac.category_id
         where c.slug = ?`,
        slug,
      ),
    ),
  ).toBe(1);

  // Removed and renamed in another tab: the message uses the current name (D26, §8.2).
  await unassignFromDemoArtifact(slug);
  await withDatabase((db) =>
    db
      .prepare('update categories set name = ?, name_key = ? where slug = ?')
      .run('Stale Renamed E2E', 'stale renamed e2e', slug),
  );
  await box.getByRole('button', { name: 'Remove category Stale E2E' }).click();
  await expect(box.getByRole('status')).toHaveText('Stale Renamed E2E was already removed.');
  await expect(chip).toHaveCount(0);

  // Archived in another tab: refused with the archived message, and gone from the picker.
  await expect(picker.locator('option', { hasText: 'Stale Renamed E2E' })).toHaveCount(1);
  await picker.selectOption({ label: 'Stale Renamed E2E' });
  await setArchived(slug, true);
  await box.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(box.getByRole('alert')).toHaveText(
    'Stale Renamed E2E is archived. Unarchive it on its page before assigning it.',
  );
  await expect(picker.locator('option', { hasText: 'Stale Renamed E2E' })).toHaveCount(0);
  await expect(picker).toBeFocused();
  expect(
    await withDatabase((db) =>
      count(
        db,
        `select count(*) as n from artifact_categories ac join categories c on c.id = ac.category_id
         where c.slug = ?`,
        slug,
      ),
    ),
  ).toBe(0);
});

test('an archived assignment shows muted and is removed without confirmation', async ({ page }) => {
  const slug = await createCategory(page, 'Archived Chip E2E');
  await assignToDemoArtifact(slug);
  await setArchived(slug, true);
  await page.goto(`/artifacts/${await demoArtifactId()}`);
  const box = categoriesCard(page);
  const chips = box.getByRole('list', { name: 'Categories' });
  await expect(chips.getByText('Archived Chip E2E (archived)')).toHaveAttribute(
    'data-variant',
    'muted',
  );
  // Archived chips come after the active ones (FR-124-14).
  await expect(chips.locator('[data-slot="badge"]').last()).toHaveText(
    'Archived Chip E2E (archived)',
  );
  await expect(
    box.getByRole('combobox', { name: 'Category' }).locator('option', {
      hasText: 'Archived Chip E2E',
    }),
  ).toHaveCount(0);
  await box.getByRole('button', { name: 'Remove category Archived Chip E2E (archived)' }).click();
  await expect(box.getByRole('status')).toHaveText(
    'Removed Archived Chip E2E. To assign it again, unarchive it on its page first.',
  );
  await expect(chips.getByText('Archived Chip E2E (archived)')).toHaveCount(0);
  await expect(box.getByRole('combobox', { name: 'Category' })).toBeFocused();
});

test('without a picker the focus goes to the chips and then to the Categories page link', async ({
  page,
}) => {
  await keepingDemoCategories(async () => {
    const slug = await createCategory(page, 'Last One E2E');
    // Every other active category is assigned already, so assigning this one removes the picker.
    await withDatabase((db) =>
      db
        .prepare(
          `insert into artifact_categories (artifact_id, category_id, created_at)
           select a.id, c.id, ? from artifacts a, categories c
           where a.slug = ? and c.archived_at is null and c.slug <> ?
           on conflict do nothing`,
        )
        .run(new Date().toISOString(), DEMO_ARTIFACT, slug),
    );
    await page.goto(`/artifacts/${await demoArtifactId()}`);
    const box = categoriesCard(page);
    const picker = box.getByRole('combobox', { name: 'Category' });
    await expect(picker.locator('option')).toHaveCount(1);
    await box.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(box.getByRole('status')).toHaveText('Assigned Last One E2E.');
    await expect(picker).toHaveCount(0);
    // D21: the sentence replaces the picker; D25: focus on the new chip's Remove.
    await expect(box.getByText('Every active category is assigned.')).toHaveText(
      'Every active category is assigned. Create more on the Categories page.',
    );
    await expect(box.getByRole('link', { name: 'Categories page' })).toHaveAttribute(
      'href',
      '/categories',
    );
    await expect(box.getByRole('button', { name: 'Remove category Last One E2E' })).toBeFocused();
    await expectCardContrast(page);

    // Archive every category: D22's sentence, and removes keep the focus on the chips.
    await withDatabase((db) =>
      db
        .prepare('update categories set archived_at = ? where archived_at is null')
        .run(new Date().toISOString()),
    );
    await page.reload();
    await expect(box.getByRole('combobox', { name: 'Category' })).toHaveCount(0);
    await expect(box.getByText('There are no active categories.')).toHaveText(
      'There are no active categories. Create or unarchive one on the Categories page.',
    );
    await expectCardContrast(page);
    const removes = box.getByRole('list', { name: 'Categories' }).getByRole('button');
    const total = await removes.count();
    expect(total).toBeGreaterThan(2);
    // The second chip's Remove: the chip after it takes its place and gets the focus.
    const third = await removes.nth(2).getAttribute('aria-label');
    await removes.nth(1).click();
    await expect(box.getByRole('status')).toHaveText(/^Removed .+\. To assign it again/);
    await expect(removes).toHaveCount(total - 1);
    await expect(box.getByRole('button', { name: third ?? '' })).toBeFocused();
    // The last chip's Remove: the focus goes to the new last chip.
    await removes.last().click();
    await expect(removes).toHaveCount(total - 2);
    await expect(removes.last()).toBeFocused();
    // Remove all: the focus ends on the Categories page link.
    while ((await removes.count()) > 0) {
      const left = await removes.count();
      await removes.first().click();
      await expect(removes).toHaveCount(left - 1);
    }
    await expect(box.getByText('No categories yet.')).toBeVisible();
    await expect(box.getByRole('link', { name: 'Categories page' })).toBeFocused();
  });
});

test('a slow assign or remove says what is happening and keeps focus the user moved away', async ({
  page,
}) => {
  await createCategory(page, 'Slow E2E');
  const artifactId = await demoArtifactId();
  await page.goto(`/artifacts/${artifactId}`);
  await page.route(`**/artifacts/${artifactId}`, async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1000));
    await route.continue();
  });
  const box = categoriesCard(page);
  const picker = box.getByRole('combobox', { name: 'Category' });
  const notes = card(page, 'Notes').getByRole('textbox', { name: 'Notes' });
  try {
    await picker.selectOption({ label: 'Slow E2E' });
    await box.getByRole('button', { name: 'Assign', exact: true }).click();
    // D24: the pending line names the pressed button; the controls wait for the save.
    await expect(box.getByRole('status')).toHaveText('Assigning…');
    await expect(picker).toBeDisabled();
    await expect(box.getByRole('button', { name: 'Assign', exact: true })).toBeDisabled();
    await expect(box.getByRole('status')).toHaveText('Assigned Slow E2E.');
    await expect(picker).toBeFocused();

    await box.getByRole('button', { name: 'Remove category Slow E2E' }).click();
    await expect(box.getByRole('status')).toHaveText('Removing…');
    await expect(
      box.getByRole('list', { name: 'Categories' }).getByRole('button').first(),
    ).toBeDisabled();
    // Focus the user moved out of the card while saving stays there (Form pattern).
    await notes.click();
    await expect(box.getByRole('status')).toHaveText('Removed Slow E2E.');
    await expect(notes).toBeFocused();
  } finally {
    await page.unrouteAll();
  }
});

test('assign and remove work by keyboard alone', async ({ page }) => {
  await createCategory(page, 'Keyboard Assign E2E');
  await page.goto(`/artifacts/${await demoArtifactId()}`);
  const box = categoriesCard(page);
  const picker = box.getByRole('combobox', { name: 'Category' });
  await picker.focus();
  // Choose by typing, as a keyboard user does in a native select.
  await page.keyboard.type('Keyboard Assign');
  await expect(picker.locator('option:checked')).toHaveText('Keyboard Assign E2E');
  await page.keyboard.press('Tab');
  await expect(box.getByRole('button', { name: 'Assign', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(box.getByRole('status')).toHaveText('Assigned Keyboard Assign E2E.');
  await expect(picker).toBeFocused();
  const remove = box.getByRole('button', { name: 'Remove category Keyboard Assign E2E' });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(box.getByRole('status')).toHaveText('Removed Keyboard Assign E2E.');
  await expect(picker).toBeFocused();
});

test('the Categories card fits a 320px screen with a 64-character name', async ({ page }) => {
  const long = 'W'.repeat(64);
  const slug = await createCategory(page, long);
  await assignToDemoArtifact(slug);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/artifacts/${await demoArtifactId()}`);
  const box = categoriesCard(page);
  await expect(box.getByRole('button', { name: `Remove category ${long}` })).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
  await setArchived(slug, true);
  await page.reload();
  await expect(
    box.getByRole('button', { name: `Remove category ${long} (archived)` }),
  ).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the Categories card's chips, status line and error have AA contrast in ${theme}`, async ({
    page,
  }) => {
    const slug = await createCategory(page, `Contrast ${theme} E2E`);
    const archivedSlug = await createCategory(page, `Contrast archived ${theme} E2E`);
    await assignToDemoArtifact(archivedSlug);
    await setArchived(archivedSlug, true);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/artifacts/${await demoArtifactId()}`);
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    const box = categoriesCard(page);
    const picker = box.getByRole('combobox', { name: 'Category' });
    await picker.selectOption({ label: `Contrast ${theme} E2E` });
    await box.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(box.getByRole('status')).toHaveText(`Assigned Contrast ${theme} E2E.`);
    const failures = (await scanTextContrast(page)).filter((row) => row.ratio < row.threshold);
    expect(failures).toEqual([]);
    // The error line: assign a category archived behind the page's back.
    await box.getByRole('button', { name: `Remove category Contrast ${theme} E2E` }).click();
    await expect(box.getByRole('status')).toHaveText(`Removed Contrast ${theme} E2E.`);
    await picker.selectOption({ label: `Contrast ${theme} E2E` });
    await setArchived(slug, true);
    await box.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(box.getByRole('alert')).toContainText('is archived');
    const errorFailures = (await scanTextContrast(page)).filter((row) => row.ratio < row.threshold);
    expect(errorFailures).toEqual([]);
  });
}
