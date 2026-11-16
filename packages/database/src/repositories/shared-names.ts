import { sql } from 'drizzle-orm';
import { artifacts, benchmarkSuites, categories } from '../schema';

// "Is this name shared?" flags for list rows (issue 227, SPEC-101 §11, SPEC-124 D17). Each is
// "<value> in (the values more than one row holds)" over the whole table, so a row reads the same
// on every page whatever else that page lists, and the web app never counts names per row. The
// inner query is not correlated: SQLite runs it once per statement and probes its result per row
// (one table scan, not one per row; Codex review of PR 234). Use a flag only in a query whose
// FROM or JOIN has the plain (unaliased) table it reads.

/** Another suite has this suite's name (names repeat; the slug, shown as "ID", does not). */
export const suiteNameShared =
  sql<boolean>`(${benchmarkSuites.name} in (select ${sql.identifier('name')} from ${benchmarkSuites} group by 1 having count(*) > 1))`.mapWith(
    Boolean,
  );

/** Another artifact has this artifact's name (names repeat, SPEC-126; the slug does not). */
export const artifactNameShared =
  sql<boolean>`(${artifacts.name} in (select ${sql.identifier('name')} from ${artifacts} group by 1 having count(*) > 1))`.mapWith(
    Boolean,
  );

/** A category's chip text: the name, plus " (archived)" for an archived one (`categoryChipLabel`). */
function chipText(name: unknown, archivedAt: unknown) {
  return sql`(case when ${archivedAt} is null then ${name} else ${name} || ' (archived)' end)`;
}

/**
 * Another category shows the same chip text (FR-124-14). Active names are unique, so this is two
 * archived categories with one name, or an active one whose name ends in " (archived)".
 */
export const categoryChipShared =
  sql<boolean>`(${chipText(categories.name, categories.archivedAt)} in (select ${chipText(sql.identifier('name'), sql.identifier('archived_at'))} from ${categories} group by 1 having count(*) > 1))`.mapWith(
    Boolean,
  );
