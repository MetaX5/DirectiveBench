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
  // Tags are listed alphabetically; the field states its limits next to it.
  await expect(tags.getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText([
    /review/,
    /security/,
  ]);
  await expect(field).toHaveAccessibleDescription(/up to 64 characters, no commas/);

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

  // Assigning the last free suite removes the field: the focus moves to its Unassign button.
  await select.press('Tab');
  await expect(suites.getByRole('button', { name: 'Assign' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(suites.getByRole('status')).toHaveText(
    `Assigned ${DEMO_SUITE}. Run it from its suite page.`,
  );
  await expect(suites.getByRole('link', { name: DEMO_SUITE })).toHaveAttribute(
    'href',
    /^\/benchmarks\//,
  );
  await expect(suites.getByRole('button', { name: `Unassign suite ${DEMO_SUITE}` })).toBeFocused();
});

// Issue 219: only a suite's ID (its slug) is unique, so a copy of the demo suite with a new
// `id:` has the same name. The CLI imports no mock suite (FR-118-05), so the copy is seeded as
// a row copy of the demo suite and its latest version, then removed (versions and assignments
// cascade).
const DEMO_SUITE_SLUG = 'mock-input-validation';
const COPY_SUITE_SLUG = 'mock-input-validation-e2e-copy';

function seedSuiteCopy(): Promise<void> {
  return withDatabase((db) => {
    const now = new Date().toISOString();
    db.prepare(
      `insert into benchmark_suites (id, slug, name, description, created_at, updated_at)
       select 'suite_e2e_copy', ?, name, description, ?, ? from benchmark_suites where slug = ?`,
    ).run(COPY_SUITE_SLUG, now, now, DEMO_SUITE_SLUG);
    db.prepare(
      `insert into benchmark_suite_versions
         (id, suite_id, version, content_hash, schema_version, definition, fixtures, source_path,
          execution_approved_at, execution_approval_source, created_at)
       select 'suitev_e2e_copy', 'suite_e2e_copy', 1, v.content_hash, v.schema_version,
              v.definition, v.fixtures, v.source_path, v.execution_approved_at,
              v.execution_approval_source, ?
         from benchmark_suite_versions v join benchmark_suites s on s.id = v.suite_id
        where s.slug = ? order by v.version desc limit 1`,
    ).run(now, DEMO_SUITE_SLUG);
  });
}

function removeSuiteCopy(): Promise<void> {
  return withDatabase((db) => {
    db.prepare('delete from benchmark_suites where slug = ?').run(COPY_SUITE_SLUG);
  });
}

test('two suites with one name get unique option labels and Unassign names (issue 219)', async ({
  page,
}) => {
  await removeSuiteCopy();
  await seedSuiteCopy();
  try {
    await page.goto(`/artifacts/${await demoArtifactId()}?tab=benchmarks`);
    const suites = card(page, 'Assigned benchmarks');
    const demoName = `${DEMO_SUITE}, ID ${DEMO_SUITE_SLUG}`;
    const copyName = `${DEMO_SUITE}, ID ${COPY_SUITE_SLUG}`;

    // One suite of the name is listed: its option is the name alone.
    const select = suites.getByRole('combobox', { name: 'Benchmark suite' });
    await expect(select.getByRole('option', { name: DEMO_SUITE, exact: true })).toHaveCount(1);

    // Both unassigned: the options add the ID and no two read alike (decision I2).
    await suites.getByRole('button', { name: `Unassign suite ${demoName}`, exact: true }).click();
    await expect(suites.getByRole('status')).toHaveText(
      `Unassigned ${DEMO_SUITE}. Its results stay in Results by version.`,
    );
    const options = await select.getByRole('option').allTextContents();
    expect(new Set(options).size).toBe(options.length);
    expect(options).toEqual(expect.arrayContaining([demoName, copyName]));
    expect(options).not.toContain(DEMO_SUITE);

    // Assign both through the form. Once the copy is assigned, the demo suite is the only
    // listed suite of the name, so its option is the name alone again.
    for (const label of [copyName, DEMO_SUITE]) {
      await select.selectOption({ label });
      await suites.getByRole('button', { name: 'Assign', exact: true }).click();
      await expect(suites.getByRole('status')).toHaveText(
        `Assigned ${DEMO_SUITE}. Run it from its suite page.`,
      );
    }

    // Each Unassign names its own suite; the visible text stays "Unassign" (decision I1).
    const list = suites.getByRole('list', { name: 'Assigned suites' });
    const buttons = list.getByRole('button');
    await expect(buttons).toHaveCount(2);
    await expect(buttons).toHaveText(['Unassign', 'Unassign']);
    const names = await buttons.evaluateAll((all) => all.map((b) => b.getAttribute('aria-label')));
    expect(new Set(names).size).toBe(2);
    for (const name of [demoName, copyName]) {
      await expect(
        list.getByRole('button', { name: `Unassign suite ${name}`, exact: true }),
      ).toHaveCount(1);
    }

    // The copy goes; the demo suite stays assigned, as other spec files expect.
    await list.getByRole('button', { name: `Unassign suite ${copyName}`, exact: true }).click();
    await expect(suites.getByRole('status')).toHaveText(
      `Unassigned ${DEMO_SUITE}. Its results stay in Results by version.`,
    );
    await expect(list.getByRole('button')).toHaveCount(1);
  } finally {
    await removeSuiteCopy();
  }
});

test('at the tag limit the field is disabled with its reason and focus stays on the list', async ({
  page,
}) => {
  const artifactId = await demoArtifactId();
  const tags = Array.from({ length: 31 }, (_, i) => `limit-${String(i).padStart(2, '0')}`);
  await withDatabase((db) =>
    db.prepare('update artifacts set tags = ? where id = ?').run(JSON.stringify(tags), artifactId),
  );
  try {
    await page.goto(`/artifacts/${artifactId}`);
    const card_ = card(page, 'Tags');
    const field = card_.getByRole('textbox', { name: 'Tag' });
    await field.fill('last');
    await field.press('Enter');
    await expect(card_.getByRole('status')).toHaveText('Added tag last.');
    await expect(field).toBeDisabled();
    await expect(field).toHaveAccessibleDescription(/has 32 tags, the most it can have/);
    await expect(card_.getByRole('button', { name: 'Add tag' })).toBeDisabled();
    await expect(card_.getByRole('button', { name: 'Remove tag last' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card_.getByRole('status')).toHaveText('Removed tag last.');
    await expect(field).toBeEnabled();
    await expect(field).toBeFocused();
  } finally {
    await withDatabase((db) =>
      db.prepare("update artifacts set tags = '[]' where id = ?").run(artifactId),
    );
  }
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

test('browser QA findings: long tags wrap, drafts and focus survive, errors clear on edit', async ({
  page,
}) => {
  const artifactId = await demoArtifactId();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/artifacts/${artifactId}`);
  const tags = card(page, 'Tags');
  const field = tags.getByRole('textbox', { name: 'Tag' });
  try {
    // A 64-character tag without spaces wraps inside the card; nothing scrolls sideways.
    const long = 'k'.repeat(64);
    await field.fill(long);
    await field.press('Enter');
    await expect(tags.getByRole('status')).toHaveText(`Added tag ${long}.`);
    const remove = await tags.getByRole('button', { name: `Remove tag ${long}` }).boundingBox();
    const box = await tags.boundingBox();
    expect((remove?.x ?? Infinity) + (remove?.width ?? 0)).toBeLessThanOrEqual(
      (box?.x ?? 0) + (box?.width ?? 0),
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);

    // A field error disappears as soon as the value changes.
    await field.fill('a, b');
    await field.press('Enter');
    await expect(tags.getByRole('alert')).toBeVisible();
    await field.press('Backspace');
    await expect(tags.getByRole('alert')).toHaveCount(0);
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');

    // Removing another tag keeps the draft in the Tag field.
    await field.fill('draft');
    await tags.getByRole('button', { name: `Remove tag ${long}` }).click();
    await expect(tags.getByRole('status')).toHaveText(`Removed tag ${long}.`);
    await expect(field).toHaveValue('draft');

    // Save notes disables itself while saving; the focus returns to the Notes field.
    const notes = card(page, 'Notes');
    await notes.getByRole('textbox', { name: 'Notes' }).fill('x');
    await notes.getByRole('button', { name: 'Save notes' }).press('Enter');
    await expect(notes.getByRole('status')).toHaveText('Saved the notes.');
    await expect(notes.getByRole('textbox', { name: 'Notes' })).toBeFocused();
  } finally {
    await withDatabase((db) =>
      db.prepare("update artifacts set tags = '[]', notes = null where id = ?").run(artifactId),
    );
  }
});

test('a slow save does not take focus from a field the user moved to', async ({ page }) => {
  const artifactId = await demoArtifactId();
  await page.goto(`/artifacts/${artifactId}`);
  await page.route(`**/artifacts/${artifactId}`, async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1000));
    await route.continue();
  });
  const tags = card(page, 'Tags');
  const notes = card(page, 'Notes').getByRole('textbox', { name: 'Notes' });
  try {
    await tags.getByRole('textbox', { name: 'Tag' }).fill('slow');
    await tags.getByRole('textbox', { name: 'Tag' }).press('Enter');
    await expect(tags.getByRole('status')).toHaveText('Saving the tags.');
    await notes.click();
    await expect(tags.getByRole('status')).toHaveText('Added tag slow.');
    await page.keyboard.type('typed while saving');
    await expect(notes).toBeFocused();
    await expect(notes).toHaveValue('typed while saving');
  } finally {
    await page.unrouteAll();
    await withDatabase((db) =>
      db.prepare("update artifacts set tags = '[]', notes = null where id = ?").run(artifactId),
    );
  }
});
