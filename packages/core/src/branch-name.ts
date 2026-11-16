import { z } from 'zod';

/** Longest branch name DirectiveBench accepts (SPEC-104 §12). */
export const MAX_BRANCH_NAME_LENGTH = 255;

/**
 * The one message for a branch name outside the safe subset (issue 58, decision B3): it names the
 * characters that are allowed, because the subset is narrower than `git check-ref-format`
 * (`feat+x` and non-ASCII names are legal in git but refused here).
 */
export const BRANCH_NAME_MESSAGE =
  'A branch name may use letters, digits, ".", "_", "-" and "/". It cannot start with "-" or ".", contain ".." or a space, or end with ".lock".';

/**
 * A branch name DirectiveBench passes to git: letters, digits, `.`, `_`, `-` and `/` segments,
 * none empty or starting with `.`, no `..`, not starting with `-` (never an option) and not ending
 * in `.lock`, at most {@link MAX_BRANCH_NAME_LENGTH} characters: a subset of what
 * `git check-ref-format` accepts. Every git argv that names a branch relies on it.
 */
export function isSafeBranchName(name: string): boolean {
  return (
    name.length <= MAX_BRANCH_NAME_LENGTH &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith('-') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    name.split('/').every((segment) => segment !== '' && !segment.startsWith('.'))
  );
}

/**
 * The Branch field of a hosted repository (SPEC-104 FR-104-07, issue 58): trimmed; empty means
 * "follow the default branch" and parses as null; anything else must be a safe branch name. The
 * web process checks the syntax with it, the runner parses the job payload with it again.
 */
export const branchNameSchema = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .refine((value) => value === null || isSafeBranchName(value), { message: BRANCH_NAME_MESSAGE });
