import { sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { artifacts, benchmarkSuites, categories } from '../schema';

// "Is this name shared?" flags for list rows (issue 227, SPEC-101 §11, SPEC-124 D17). Each is a
// correlated `exists` over the whole table, so a row reads the same on every page whatever else
// that page lists, and the web app never counts names per row. Use them only in a query whose
// FROM or JOIN has the plain (unaliased) table they correlate with.

// An alias renders as its name only, so each FROM names the table and the alias itself.
const otherSuites = alias(benchmarkSuites, 'other_suites');
const otherArtifacts = alias(artifacts, 'other_artifacts');
const otherCategories = alias(categories, 'other_categories');

/** Another suite has this suite's name (names repeat; the slug, shown as "ID", does not). */
export const suiteNameShared =
  sql<boolean>`exists (select 1 from ${benchmarkSuites} ${sql.identifier('other_suites')} where ${otherSuites.name} = ${benchmarkSuites.name} and ${otherSuites.id} <> ${benchmarkSuites.id})`.mapWith(
    Boolean,
  );

/** Another artifact has this artifact's name (names repeat, SPEC-126; the slug does not). */
export const artifactNameShared =
  sql<boolean>`exists (select 1 from ${artifacts} ${sql.identifier('other_artifacts')} where ${otherArtifacts.name} = ${artifacts.name} and ${otherArtifacts.id} <> ${artifacts.id})`.mapWith(
    Boolean,
  );

/**
 * Another category shows the same chip text: the name, plus " (archived)" for an archived one
 * (the web app's `categoryChipLabel`, FR-124-14). Active names are unique, so this is two archived
 * categories with one name, or an active one whose name ends in " (archived)".
 */
export const categoryChipShared =
  sql<boolean>`exists (select 1 from ${categories} ${sql.identifier('other_categories')} where ${otherCategories.id} <> ${categories.id} and (case when ${otherCategories.archivedAt} is null then ${otherCategories.name} else ${otherCategories.name} || ' (archived)' end) = (case when ${categories.archivedAt} is null then ${categories.name} else ${categories.name} || ' (archived)' end))`.mapWith(
    Boolean,
  );
