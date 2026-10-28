import {
  MAX_ARTIFACT_NOTES_LENGTH,
  MAX_ARTIFACT_TAG_LENGTH,
  MAX_ARTIFACT_TAGS,
} from '@directivebench/database';
import { z } from 'zod';

/**
 * What an artifact's Tags, Notes or Benchmarks form shows after a submit (SPEC-101 §11, issue
 * #64). `value` is the text the user entered, given back so an error never loses it.
 */
export type MetadataFormState =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'fieldError'; message: string; value: string }
  | { kind: 'error'; message: string };

export const metadataLimits = {
  tags: MAX_ARTIFACT_TAGS,
  tagLength: MAX_ARTIFACT_TAG_LENGTH,
  notesLength: MAX_ARTIFACT_NOTES_LENGTH,
} as const;

export const ARTIFACT_GONE_MESSAGE =
  'This artifact no longer exists. Go back to Artifacts to see the current list.';
export const INCOMPLETE_FORM_MESSAGE = 'The form was incomplete. Reload the page and try again.';
export const SUITE_GONE_MESSAGE =
  'This suite no longer exists. Reload the page to see the current list.';

const CONTROL_CHARACTER = /\p{Cc}/u;

const idSchema = z.string().min(1);

/**
 * A tag is free text, trimmed and lower-cased (FR-101-07). Commas and control characters are
 * refused so a tag list can be read and typed back unambiguously.
 */
export const tagSchema = z
  .string({ error: 'Enter a tag.' })
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1, 'Enter a tag.')
      .max(
        MAX_ARTIFACT_TAG_LENGTH,
        `A tag can be at most ${MAX_ARTIFACT_TAG_LENGTH} characters. Shorten it.`,
      )
      .refine(
        (value) => !value.includes(','),
        'A tag cannot contain a comma. Add each tag on its own.',
      )
      .refine(
        (value) => !CONTROL_CHARACTER.test(value),
        'A tag cannot contain line breaks or other control characters.',
      ),
  );

export const addTagSchema = z.object({ artifactId: idSchema, tag: tagSchema });
export const removeTagSchema = z.object({ artifactId: idSchema, tag: z.string().min(1) });

/**
 * Browsers submit a textarea's line breaks as CR LF; notes are stored with LF, as typed. Notes
 * that are only whitespace are cleared (`null`).
 */
export const notesSchema = z.object({
  artifactId: idSchema,
  notes: z
    .string({ error: 'Enter the notes as text.' })
    .transform((value) => value.replace(/\r\n?/g, '\n'))
    .pipe(
      z
        .string()
        .max(
          MAX_ARTIFACT_NOTES_LENGTH,
          `Notes can be at most ${MAX_ARTIFACT_NOTES_LENGTH.toLocaleString('en-US')} characters. Shorten them.`,
        ),
    )
    .transform((value) => (value.trim() === '' ? null : value)),
});

export const suiteAssignmentSchema = z.object({ artifactId: idSchema, suiteId: idSchema });

/**
 * The state for a refused submit: an issue with the user's field is shown under it with the
 * entered value kept; any other issue (a missing or altered hidden id) is a general error.
 */
export function refused(error: z.ZodError, field: string, value: string): MetadataFormState {
  const issue = error.issues.every((i) => i.path[0] === field) ? error.issues[0] : undefined;
  return issue
    ? { kind: 'fieldError', message: issue.message, value }
    : { kind: 'error', message: INCOMPLETE_FORM_MESSAGE };
}

/** The text a form field held, or an empty string for a missing field or a file upload. */
export function fieldText(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}
