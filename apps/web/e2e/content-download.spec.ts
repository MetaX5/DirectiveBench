import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { e2eTmpRoot, withDatabase } from './support';

/**
 * Issue #52 (SPEC-101 §10 to §12): the raw view cannot show CR characters (lesson 2026-10-20),
 * so the Content tab's Download and Copy give a stored file's exact bytes. The fixture has CRLF,
 * a lone CR, non-ASCII text and a supporting HTML file; it is registered and scanned through the
 * UI, as a user would.
 */

const RUNNER_TIMEOUT = 30_000;

const sources = realpathSync(mkdtempSync(join(e2eTmpRoot(), 'content-download-')));
const REPOSITORY = 'crlf-download';
const repo = join(sources, REPOSITORY);
const skillDir = '.agents/skills/e2e-crlf-download';

const SKILL = [
  '---',
  'name: e2e-crlf-download',
  'description: A skill with Windows line endings.',
  '---',
  '# CRLF skill',
  '',
  'A lone CR here\rand Zażółć gęślą jaźń ✓',
  '',
].join('\r\n');
const PAGE_HTML = '<!doctype html>\r\n<script>window.__pwned = 1</script>\r\n';

const files: Record<string, string> = {
  [`${skillDir}/SKILL.md`]: SKILL,
  [`${skillDir}/assets/page.html`]: PAGE_HTML,
};

/** Jobs that existed before the fixture repository was registered and scanned. */
let jobsBefore = new Set<string>();

test.beforeAll(async () => {
  jobsBefore = await withDatabase(
    (db) => new Set((db.prepare('select id from jobs').all() as { id: string }[]).map((j) => j.id)),
  );
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, relPath)), { recursive: true });
    writeFileSync(join(repo, relPath), content);
  }
});

// Other spec files count artifacts and jobs (home, management): remove the fixture repository,
// its artifacts and the register and scan jobs again.
test.afterAll(async () => {
  await withDatabase((db) => {
    const repository = db.prepare('select id from repositories where name = ?').get(REPOSITORY) as
      { id: string } | undefined;
    if (repository) {
      db.prepare(
        `delete from artifacts where id in (
           select artifact_id from artifact_occurrences where repository_id = ?)`,
      ).run(repository.id);
      db.prepare('delete from repositories where id = ?').run(repository.id);
    }
    const remove = db.prepare('delete from jobs where id = ?');
    for (const { id } of db.prepare('select id from jobs').all() as { id: string }[]) {
      if (!jobsBefore.has(id)) remove.run(id);
    }
  });
  rmSync(sources, { recursive: true, force: true });
});

async function openContentTab(page: Page): Promise<void> {
  await page.goto('/artifacts?q=e2e-crlf-download');
  await page.getByRole('link', { name: 'e2e-crlf-download' }).click();
  await page
    .getByRole('navigation', { name: 'Artifact sections' })
    .getByRole('link', { name: 'Content' })
    .click();
  await expect(page.getByTestId('content-path')).toHaveText('SKILL.md');
}

test.describe.serial('exact bytes from the Content tab (issue #52)', () => {
  test('registers and scans the CRLF fixture', async ({ page }) => {
    await page.goto('/repositories');
    await page.getByLabel('Path').fill(repo);
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByTestId('registration-status')).toHaveText(
      `Registered crlf-download (Local directory, ${repo}).`,
      { timeout: RUNNER_TIMEOUT },
    );
    await page.getByRole('button', { name: 'Scan crlf-download' }).click();
    await expect(page.getByTestId('scan-status')).toContainText('Scanned crlf-download:', {
      timeout: RUNNER_TIMEOUT,
    });
  });

  test('Download saves the stored file byte for byte, CRLF and a lone CR kept', async ({
    page,
  }) => {
    await openContentTab(page);
    const source = readFileSync(join(repo, skillDir, 'SKILL.md'));
    // Loaded as HTML, the raw view shows LF only (the parser drops CR, lesson 2026-10-20): that
    // is why Download and Copy exist.
    await page.reload();
    const raw = await page.getByTestId('artifact-raw').evaluate((el) => el.textContent ?? '');
    expect(raw.includes('\r')).toBe(false);
    await expect(page.getByTestId('raw-notice')).toContainText('Download and Copy give them');
    await expect(page.getByTestId('bytes-notice')).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download SKILL.md' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('SKILL.md');
    const saved = readFileSync(await download.path());
    expect(saved.equals(source)).toBe(true);
  });

  test('Copy puts the exact stored text on the clipboard, by keyboard too', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openContentTab(page);
    const copy = page.getByRole('button', { name: 'Copy the content of SKILL.md' });
    await copy.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('copy-file-status')).toHaveText('Copied.');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(Buffer.from(copied, 'utf8').equals(readFileSync(join(repo, skillDir, 'SKILL.md')))).toBe(
      true,
    );
  });

  test('a refused clipboard says the file was not copied and points at Download', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied'));
    });
    await openContentTab(page);
    await page.getByRole('button', { name: 'Copy the content of SKILL.md' }).click();
    await expect(page.getByTestId('copy-file-status')).toHaveText(
      'Not copied: the browser blocked the clipboard. Use Download instead.',
    );
  });

  test('the file route serves an HTML file as an inert text attachment and fails closed', async ({
    page,
  }) => {
    await openContentTab(page);
    await page.getByTestId('file-tree').getByRole('link', { name: 'page.html' }).click();
    await expect(page.getByTestId('content-path')).toHaveText('assets/page.html');
    const href = await page
      .getByRole('link', { name: 'Download assets/page.html' })
      .getAttribute('href');
    expect(href).toMatch(/^\/artifacts\/art_[\w-]+\/file\?version=1&path=assets%2Fpage\.html$/);

    const response = await page.request.get(href!);
    expect(response.status()).toBe(200);
    expect(response.headers()).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="page.html"; filename*=UTF-8''page.html`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'no-store',
    });
    expect(
      (await response.body()).equals(readFileSync(join(repo, skillDir, 'assets/page.html'))),
    ).toBe(true);

    // No fallback: an unknown version or path is a 404, a malformed request a 400.
    const base = href!.split('?')[0]!;
    expect((await page.request.get(`${base}?version=9&path=SKILL.md`)).status()).toBe(404);
    expect((await page.request.get(`${base}?version=1&path=nope.md`)).status()).toBe(404);
    expect(
      (await page.request.get('/artifacts/art_nope/file?version=1&path=SKILL.md')).status(),
    ).toBe(404);
    expect((await page.request.get(`${base}?version=x&path=SKILL.md`)).status()).toBe(400);
    expect(await page.evaluate(() => (window as { __pwned?: unknown }).__pwned)).toBeUndefined();
  });
});
