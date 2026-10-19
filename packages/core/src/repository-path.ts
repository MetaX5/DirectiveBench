import { isAbsolute, parse, relative, sep } from 'node:path';
import { z } from 'zod';

/** Longest path accepted for registration (PATH_MAX on Linux). */
export const MAX_REPOSITORY_PATH_LENGTH = 4096;

/** True for `~` and `~/…`: the only home-directory forms registration accepts (FR-104-03). */
function isHomeRelative(path: string): boolean {
  return path === '~' || path.startsWith('~/');
}

/**
 * Expands `~` and `~/…` to `homeDir`. Every other input is returned unchanged; `~user` is not
 * expanded, so the path schema rejects it as relative. The rest of the path is appended as is
 * (no textual `..` normalisation), so `realpath` can resolve `..` after following symlinks.
 */
export function expandHomePath(path: string, homeDir: string): string {
  return isHomeRelative(path) ? `${homeDir}${path.slice(1)}` : path;
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

/**
 * True for a filesystem root: `/`, or a drive or UNC share root on Windows. Registering one is
 * rejected (SPEC-104 FR-104-18), because a scan would read the whole disk.
 */
export function isFilesystemRoot(path: string): boolean {
  return parse(path).root === path;
}

/** How a canonical absolute path relates to another one (SPEC-104 FR-104-18). */
export type PathRelation = 'same' | 'inside' | 'contains' | 'unrelated';

/** True when `child` is strictly below `parent` (both canonical absolute paths). */
function isStrictlyInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  // Paths on another Windows drive come back absolute; `..foo` is a name, not a parent step.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Compares two canonical absolute paths textually (both come from `realpath`): `inside` when
 * `path` is strictly below `other`, `contains` when `other` is strictly below `path`.
 */
export function pathRelation(path: string, other: string): PathRelation {
  if (path === other) return 'same';
  if (isStrictlyInside(path, other)) return 'inside';
  if (isStrictlyInside(other, path)) return 'contains';
  return 'unrelated';
}
