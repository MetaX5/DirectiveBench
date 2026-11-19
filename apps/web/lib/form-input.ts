import { z } from 'zod';

/**
 * False for text holding U+0000 (NUL). The database refuses such text (`NulInTextError`,
 * SPEC-006 §1 "Text", issue 265), also as a lookup parameter, so every form field and URL value
 * that reaches a repository function is checked with this first (issue 273): user text gets a
 * field message, a hidden id the form's general refusal.
 */
export function hasNoNul(value: string): boolean {
  return !value.includes('\0');
}

/** A hidden id a form posts back: not empty and without U+0000. */
export const idSchema = z.string().min(1).refine(hasNoNul);
