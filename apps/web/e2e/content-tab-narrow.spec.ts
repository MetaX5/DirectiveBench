import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { withDatabase } from './support';

// Issue #295: at 320px the Content tab scrolled sideways when the raw view held a line with no
// break opportunity. The seeded artifact has its own name, slug and content hash, so it clashes
// with nothing, and it is removed afterwards because other spec files share the database.

const ARTIFACT_ID = 'art_e2e_295_long_line';
const VERSION_ID = 'artv_e2e_295_long_line';
const LONG_FILE = 'references/long-line.txt';
// One unbroken token, far wider than a 320px viewport (a URL, a hash or base64 in a real file).
const LONG_LINE = `https://example.com/${'a1b2c3d4'.repeat(40)}`;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

test.beforeAll(() =>
  withDatabase((db) => {
    db.prepare('delete from artifacts where id = ?').run(ARTIFACT_ID);
    const now = new Date().toISOString();
    const skill = '---\nname: e2e-295-long-line\ndescription: A long raw line.\n---\n# Long line\n';
    const long = `${LONG_LINE}\n`;
    const files = [
      { path: 'SKILL.md', sha256: sha256(skill), size: skill.length, content: skill },
      { path: LONG_FILE, sha256: sha256(long), size: long.length, content: long },
    ];
    db.prepare(
      `insert into artifacts (id, slug, name, type, description, notes, tags, created_at,
         updated_at, format, source_version_id)
       values (?, ?, ?, 'skill', 'A long raw line.', null, '[]', ?, ?, 'skill-md', ?)`,
    ).run(ARTIFACT_ID, 'e2e-295-long-line', 'e2e-295-long-line', now, now, VERSION_ID);
    db.prepare(
      `insert into artifact_versions (id, artifact_id, version, content_hash, format,
         primary_file, files, parsed_metadata, created_at)
       values (?, ?, 1, ?, 'skill-md', 'SKILL.md', ?, '{}', ?)`,
    ).run(VERSION_ID, ARTIFACT_ID, sha256(`e2e-295:${long}`), JSON.stringify(files), now);
  }),
);

test.afterAll(() =>
  withDatabase((db) => {
    db.prepare('delete from artifacts where id = ?').run(ARTIFACT_ID);
  }),
);

test('the Content tab does not scroll sideways at 320px with a long raw line', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/artifacts/${ARTIFACT_ID}?tab=content&file=${encodeURIComponent(LONG_FILE)}`);
  const raw = page.getByTestId('artifact-raw');
  await expect(raw).toHaveText(LONG_LINE);

  // The page itself never scrolls horizontally ...
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth);

  // ... and the raw view stays inside the viewport, wrapping the line in its own box.
  const box = await raw.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
});
