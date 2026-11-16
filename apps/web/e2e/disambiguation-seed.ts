import type { DatabaseSync } from 'node:sqlite';
import { DEMO_ARTIFACT } from './support';

// Seeds for issue 227's name clashes (setup only, through the shared e2e database). Each seed has
// a matching removal, so a spec leaves the database as it found it (lesson 2026-11-10).

export const DEMO_SUITE_SLUG = 'mock-input-validation';
export const COPY_SUITE_SLUG = 'mock-input-validation-e2e-227';
export const TWIN_ARTIFACT_SLUG = `${DEMO_ARTIFACT}-e2e-227`;
export const CLASH_CATEGORY_SLUGS = ['e2e-platform', 'e2e-platform-2'] as const;
export const CLASH_CATEGORY_NAME = 'E2E Platform';

const TWIN_ARTIFACT_ID = 'art_e2e_227_twin';
const CLASH_CATEGORY_IDS = ['cat_e2e_227_a', 'cat_e2e_227_b'];

export function idOf(db: DatabaseSync, table: 'artifacts' | 'benchmark_suites', slug: string) {
  const row = db.prepare(`select id from ${table} where slug = ?`).get(slug) as
    { id: string } | undefined;
  if (!row) throw new Error(`No ${table} row with slug ${slug}`);
  return row.id;
}

/**
 * A row copy of the demo suite and its latest version with a new ID: the same name, as a copied
 * suite folder with a new `id:` gives. The CLI imports no mock suite (FR-118-05).
 */
export function seedSuiteCopy(db: DatabaseSync): void {
  removeSuiteCopy(db);
  const now = new Date().toISOString();
  db.prepare(
    `insert into benchmark_suites (id, slug, name, description, created_at, updated_at)
     select 'suite_e2e_227', ?, name, description, ?, ? from benchmark_suites where slug = ?`,
  ).run(COPY_SUITE_SLUG, now, now, DEMO_SUITE_SLUG);
  db.prepare(
    `insert into benchmark_suite_versions
       (id, suite_id, version, content_hash, schema_version, definition, fixtures, source_path,
        execution_approved_at, execution_approval_source, created_at)
     select 'suitev_e2e_227', 'suite_e2e_227', 1, v.content_hash, v.schema_version,
            v.definition, v.fixtures, v.source_path, v.execution_approved_at,
            v.execution_approval_source, ?
       from benchmark_suite_versions v join benchmark_suites s on s.id = v.suite_id
      where s.slug = ? order by v.version desc limit 1`,
  ).run(now, DEMO_SUITE_SLUG);
}

/** Removes the suite copy; its version and assignments cascade. */
export function removeSuiteCopy(db: DatabaseSync): void {
  db.prepare('delete from benchmark_suites where slug = ?').run(COPY_SUITE_SLUG);
}

/** Two archived categories named "E2E Platform", both assigned to the demo artifact. */
export function seedChipClash(db: DatabaseSync): void {
  removeChipClash(db);
  const artifact = idOf(db, 'artifacts', DEMO_ARTIFACT);
  const now = new Date().toISOString();
  CLASH_CATEGORY_IDS.forEach((id, i) => {
    db.prepare(
      `insert into categories (id, slug, name, name_key, description, predefined, archived_at,
         created_at, updated_at)
       values (?, ?, ?, ?, null, 0, ?, ?, ?)`,
    ).run(
      id,
      CLASH_CATEGORY_SLUGS[i] as string,
      CLASH_CATEGORY_NAME,
      CLASH_CATEGORY_NAME.toLowerCase(),
      now,
      now,
      now,
    );
    db.prepare(
      'insert into artifact_categories (artifact_id, category_id, created_at) values (?, ?, ?)',
    ).run(artifact, id, now);
  });
}

export function removeChipClash(db: DatabaseSync): void {
  for (const id of CLASH_CATEGORY_IDS) {
    db.prepare('delete from artifact_categories where category_id = ?').run(id);
    db.prepare('delete from categories where id = ?').run(id);
  }
}

/** A row copy of the demo artifact with a new slug (the same name), assigned to the demo suite. */
export function seedArtifactTwin(db: DatabaseSync): void {
  removeArtifactTwin(db);
  const suite = idOf(db, 'benchmark_suites', DEMO_SUITE_SLUG);
  const demo = db.prepare('select * from artifacts where slug = ?').get(DEMO_ARTIFACT) as Record<
    string,
    string | number | null
  >;
  const twin: Record<string, string | number | null> = {
    ...demo,
    id: TWIN_ARTIFACT_ID,
    slug: TWIN_ARTIFACT_SLUG,
  };
  const columns = Object.keys(twin);
  db.prepare(
    `insert into artifacts (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((c) => twin[c] ?? null));
  db.prepare(
    'insert into artifact_benchmark_assignments (artifact_id, suite_id, created_at) values (?, ?, ?)',
  ).run(TWIN_ARTIFACT_ID, suite, new Date().toISOString());
}

export function removeArtifactTwin(db: DatabaseSync): void {
  db.prepare('delete from artifact_benchmark_assignments where artifact_id = ?').run(
    TWIN_ARTIFACT_ID,
  );
  db.prepare('delete from artifacts where id = ?').run(TWIN_ARTIFACT_ID);
}
