import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

/** Longest path accepted for registration (PATH_MAX on Linux). */
export const MAX_REPOSITORY_PATH_LENGTH = 4096;

/** True for `~` and `~/…`: the only home-directory forms registration accepts (FR-104-03). */
function isHomeRelative(path: string): boolean {
  return path === '~' || path.startsWith('~/');
}

/**
 * Expands `~` and `~/…` to `homeDir`. Every other input is returned unchanged; `~user` is not
 * expanded, so the path schema rejects it as relative.
 */
export function expandHomePath(path: string, homeDir: string): string {
  return isHomeRelative(path) ? join(homeDir, path.slice(1)) : path;
}

/**
 * The path field of a local repository registration (SPEC-104 FR-104-03). Shared by the web form
 * and the runner's job payload, so both reject the same input. It checks syntax only; whether
 * the directory exists is decided by the runner, which owns filesystem access.
 */
export const repositoryPathInputSchema = z
  .string()
  .trim()
  // `abort` stops at the first failed check, so the field shows exactly one message.
  .min(1, { message: 'Enter the path of a local directory.', abort: true })
  .max(MAX_REPOSITORY_PATH_LENGTH, {
    message: `The path is longer than ${MAX_REPOSITORY_PATH_LENGTH} characters.`,
    abort: true,
  })
  .refine((path) => !path.includes('\0'), {
    message: 'The path contains a NUL character.',
    abort: true,
  })
  .refine((path) => isHomeRelative(path) || isAbsolute(path), {
    message: 'Enter an absolute path, for example /home/you/project or ~/project.',
  });
