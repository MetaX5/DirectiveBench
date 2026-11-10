import {
  CATEGORY_DESCRIPTION_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  normalizeCategoryName,
} from '@directivebench/core';
import type {
  ArtifactCategory,
  AssignArtifactCategoryOutcome,
  CreateCategoryOutcome,
  SetCategoryArchivedOutcome,
  UnassignArtifactCategoryOutcome,
  UpdateCategoryOutcome,
} from '@directivebench/database';
import { z } from 'zod';
import {
  ARTIFACT_GONE_MESSAGE,
  INCOMPLETE_FORM_MESSAGE,
  type MetadataFormState,
} from './artifact-metadata';
import { formatCount } from './utils';

// Validation, messages and display rules of the category forms and pages (SPEC-124 §8.3, §11,
// §11.2 and §13). The Server Actions in `actions.ts` parse with these schemas and map each
// repository outcome to a form state here.

/** The text fields of a category form. */
export type CategoryField = 'name' | 'description';

/** What the user entered, given back after an error so neither field loses it (D14). */
export interface CategoryValues {
  name: string;
  description: string;
}

/**
 * What a category form shows after a submit (SPEC-124 §8.3, D14): the kinds of
 * `MetadataFormState`, plus on a field error the field to mark and both entered values.
 */
export type CategoryFormState =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'fieldError'; message: string; field: CategoryField; values: CategoryValues }
  | { kind: 'error'; message: string };

export const CATEGORY_GONE_MESSAGE = 'This category no longer exists. Reload the page.';

const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * A category name: control characters are refused on the raw input, before
 * `normalizeCategoryName` turns line breaks and tabs into spaces (§8.3, maintainer decision
 * 2026-11-05); then 1 to 64 characters after normalisation. A name without a Latin letter or
 * digit is valid: the repository generates its slug (A5).
 */
export const categoryNameSchema = z
  .string()
  .refine((value) => !CONTROL_CHARACTER.test(value), {
    message: 'A name cannot contain line breaks or other control characters.',
    abort: true,
  })
  .transform(normalizeCategoryName)
  .pipe(
    z
      .string()
      .min(1, 'Enter a name.')
      .max(
        CATEGORY_NAME_MAX_LENGTH,
        `A name can be at most ${CATEGORY_NAME_MAX_LENGTH} characters. Shorten it.`,
      ),
  );

/** An optional, single-line description of at most 500 characters; empty means none (`null`). */
export const categoryDescriptionSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .max(
        CATEGORY_DESCRIPTION_MAX_LENGTH,
        `A description can be at most ${CATEGORY_DESCRIPTION_MAX_LENGTH} characters. Shorten it.`,
      )
      .refine(
        (value) => !CONTROL_CHARACTER.test(value),
        'A description cannot contain line breaks or other control characters.',
      ),
  )
  .transform((value) => (value === '' ? null : value));

const idSchema = z.string().min(1);

export const createCategorySchema = z.object({
  name: categoryNameSchema,
  description: categoryDescriptionSchema,
});

export const updateCategorySchema = createCategorySchema.extend({ id: idSchema });

/** The Status card's form: a hidden `intent` of `archive` or `unarchive` (no boolean, SPEC-014). */
export const archiveCategorySchema = z
  .object({ id: idSchema, intent: z.enum(['archive', 'unarchive']) })
  .transform(({ id, intent }) => ({
    id,
    state: intent === 'archive' ? ('archived' as const) : ('active' as const),
  }));

/** The Categories card's assign and remove forms on the artifact page (§8.3, Phase 3). */
export const artifactCategorySchema = z.object({ artifactId: idSchema, categoryId: idSchema });

function isCategoryField(value: unknown): value is CategoryField {
  return value === 'name' || value === 'description';
}

/**
 * The state for a refused submit: an issue with the user's fields is shown under the form with
 * both values kept and the first such field marked; a missing field or an altered hidden id is
 * a general error.
 */
export function categoryRefused(error: z.ZodError, values: CategoryValues): CategoryFormState {
  const userIssues = error.issues.every(
    (issue) => isCategoryField(issue.path[0]) && issue.code !== 'invalid_type',
  );
  const [first] = error.issues;
  return userIssues && first && isCategoryField(first.path[0])
    ? { kind: 'fieldError', message: first.message, field: first.path[0], values }
    : { kind: 'error', message: INCOMPLETE_FORM_MESSAGE };
}

/** "1 artifact", "1,240 artifacts". */
export function artifactsPhrase(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'artifact' : 'artifacts'}`;
}

function nameTaken(existing: { name: string }, values: CategoryValues): CategoryFormState {
  return {
    kind: 'fieldError',
    message: `A category named ${existing.name} already exists. Choose another name.`,
    field: 'name',
    values,
  };
}

/** The New category form's state for a `createCategory` outcome (FR-124-04 to FR-124-06). */
export function createCategoryState(
  outcome: CreateCategoryOutcome,
  values: CategoryValues,
): CategoryFormState {
  switch (outcome.status) {
    case 'created':
      return { kind: 'success', message: `Created ${outcome.category.name}.` };
    case 'name-taken':
      return nameTaken(outcome.existing, values);
    case 'slug-taken': {
      const { existing } = outcome;
      return {
        kind: 'fieldError',
        message: existing.archived
          ? `The archived category ${existing.name} already uses the link ${existing.slug}. Unarchive it on its page instead.`
          : `The name gives the link ${existing.slug}, which ${existing.name} already uses. Choose another name.`,
        field: 'name',
        values,
      };
    }
  }
}

/** The Details form's state for an `updateCategory` outcome (FR-124-07). */
export function updateCategoryState(
  outcome: UpdateCategoryOutcome,
  values: CategoryValues,
): CategoryFormState {
  switch (outcome.status) {
    case 'updated': {
      const { category } = outcome;
      return {
        kind: 'success',
        message:
          category.name === outcome.previousName
            ? 'Saved.'
            : `Renamed to ${category.name}. Its slug stays ${category.slug}, so links keep working.`,
      };
    }
    case 'unchanged':
      return { kind: 'success', message: 'Nothing changed.' };
    case 'name-taken':
      return nameTaken(outcome.existing, values);
    case 'not-found':
      return { kind: 'error', message: CATEGORY_GONE_MESSAGE };
  }
}

/**
 * The Status form's state for a `setCategoryArchived` outcome (FR-124-08, FR-124-09).
 * `artifactCount` is the number of artifacts the category stays on, read after the write.
 */
export function archiveCategoryState(
  outcome: SetCategoryArchivedOutcome,
  artifactCount: number,
): CategoryFormState {
  switch (outcome.status) {
    case 'archived': {
      const { name } = outcome.category;
      return {
        kind: 'success',
        message:
          artifactCount === 0
            ? `Archived ${name}.`
            : `Archived ${name}. It stays on ${artifactsPhrase(artifactCount)}.`,
      };
    }
    case 'already-archived':
      return { kind: 'success', message: `${outcome.category.name} is already archived.` };
    case 'unarchived':
      return {
        kind: 'success',
        message: `Unarchived ${outcome.category.name}. It is back in pickers and filters.`,
      };
    case 'already-active':
      return { kind: 'success', message: `${outcome.category.name} is already active.` };
    case 'name-taken':
      return {
        kind: 'error',
        message: `An active category is already named ${outcome.existing.name}. Rename one of them first.`,
      };
    case 'not-found':
      return { kind: 'error', message: CATEGORY_GONE_MESSAGE };
  }
}

/** The Archive panel's reason (§11, D15). */
export function archiveReason(artifactCount: number): string {
  return `It leaves pickers, filters and the bulk form. ${
    artifactCount === 0
      ? 'No artifact has it.'
      : `It stays on ${artifactsPhrase(artifactCount)}, shown as archived.`
  }`;
}

/** The Status card's text for an archived category (§11, D15). */
export function archivedStatusText(artifactCount: number): string {
  return artifactCount === 0
    ? 'Archived. No artifact has it.'
    : `Archived. It stays on ${artifactsPhrase(artifactCount)}.`;
}

/** How an assigned category reads on a chip: archived ones say so (FR-124-14, UD-6). */
export function categoryChipLabel(category: { name: string; archived: boolean }): string {
  return category.archived ? `${category.name} (archived)` : category.name;
}

/**
 * Options of the Artifacts category filter (FR-124-15, D12): the active categories in the given
 * order, then the selected category when it is archived, so the form shows the real filter.
 */
export function categoryFilterOptions(
  categories: readonly { slug: string; name: string; archivedAt: string | null }[],
  selected: string | undefined,
): { value: string; label: string }[] {
  const options = categories
    .filter((c) => c.archivedAt === null)
    .map((c) => ({ value: c.slug, label: c.name }));
  const archived = categories.find((c) => c.slug === selected && c.archivedAt !== null);
  if (archived) options.push({ value: archived.slug, label: `${archived.name} (archived)` });
  return options;
}

/** The Categories card's state for an `assignArtifactCategory` outcome (FR-124-11, D24). */
export function assignCategoryState(outcome: AssignArtifactCategoryOutcome): MetadataFormState {
  switch (outcome.status) {
    case 'assigned':
      return { kind: 'success', message: `Assigned ${outcome.category.name}.` };
    case 'already-assigned':
      return { kind: 'success', message: `${outcome.category.name} is already assigned.` };
    case 'category-archived':
      return {
        kind: 'error',
        message: `${outcome.category.name} is archived. Unarchive it on its page before assigning it.`,
      };
    case 'category-not-found':
      return { kind: 'error', message: CATEGORY_GONE_MESSAGE };
    case 'artifact-not-found':
      return { kind: 'error', message: ARTIFACT_GONE_MESSAGE };
  }
}

/** The Categories card's state for an `unassignArtifactCategory` outcome (FR-124-12, D23, D24). */
export function unassignCategoryState(outcome: UnassignArtifactCategoryOutcome): MetadataFormState {
  switch (outcome.status) {
    case 'removed': {
      const { name, archived } = outcome.category;
      return {
        kind: 'success',
        message: archived
          ? `Removed ${name}. To assign it again, unarchive it on its page first.`
          : `Removed ${name}.`,
      };
    }
    case 'not-assigned':
      return { kind: 'success', message: `${outcome.category.name} was already removed.` };
    case 'category-not-found':
      return { kind: 'error', message: CATEGORY_GONE_MESSAGE };
    case 'artifact-not-found':
      return { kind: 'error', message: ARTIFACT_GONE_MESSAGE };
  }
}

/**
 * What the artifact page's Categories card shows (§11, §11.3), computed on the server so the
 * client card imports no values from core (lesson 2026-11-05): the chips with their labels, the
 * active categories (`listActiveCategoryNames`) not yet assigned (the picker's options, by name), and, when there are none,
 * which sentence replaces the picker (D21: every active category is assigned; D22: no active
 * category exists).
 */
export interface CategoriesCardModel {
  chips: { id: string; label: string; archived: boolean }[];
  available: { id: string; name: string }[];
  noPicker: 'all-assigned' | 'none-active' | null;
}

export function categoriesCardModel(
  assigned: readonly ArtifactCategory[],
  active: readonly { id: string; name: string }[],
): CategoriesCardModel {
  const assignedIds = new Set(assigned.map((c) => c.id));
  const available = active
    .filter((c) => !assignedIds.has(c.id))
    .map((c) => ({ id: c.id, name: c.name }));
  return {
    chips: assigned.map((c) => ({ id: c.id, label: categoryChipLabel(c), archived: c.archived })),
    available,
    noPicker: available.length > 0 ? null : active.length > 0 ? 'all-assigned' : 'none-active',
  };
}
