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
 * A canonical absolute location as the runner stored or reported it (no trimming, so a directory
 * name that ends in a space survives the round trip). Used for the location a user confirmed
 * after a broad or overlapping registration notice (SPEC-104 FR-104-18).
 */
export const repositoryLocationSchema = z
  .string()
  .min(1)
  .max(MAX_REPOSITORY_PATH_LENGTH)
  .refine((path) => !path.includes('\0'), { message: 'The location contains a NUL character.' })
  .refine((path) => isAbsolute(path), { message: 'The location is not an absolute path.' });

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

/** True for `''` and `.`: the repository root, which contains every path (FR-125-03). */
function isRepositoryRoot(path: string): boolean {
  return path === '' || path === '.';
}

/** UTF-16 code-unit order, so every path below `p/` forms one contiguous range. */
function byCodeUnit(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/** Index of the first entry of the sorted `list` that is not less than `value`. */
function lowerBound(list: readonly string[], value: string): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((list[middle] as string) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The active occurrence paths a complete scan did not find and may mark missing (SPEC-125
 * FR-125-03, FR-125-04): not discovered, and not equal to, inside or containing an unobserved
 * path, compared by whole `/` segments (`a` contains `a/b/SKILL.md`, not `ab/SKILL.md`). `''` and
 * `.` contain every path, on either side. Exact comparison on the stored strings. Each path checks
 * its own ancestors in a set and its descendants with one binary search in the sorted unobserved
 * list, so the cost is O((n + u) log u) times the path depth (NFR-125-01). Pure; keeps the order
 * of `active`.
 */
export function unseenOccurrencePaths(input: {
  active: readonly string[];
  discovered: readonly string[];
  unobserved: readonly string[];
}): string[] {
  const unobserved = new Set(input.unobserved);
  if ([...unobserved].some(isRepositoryRoot)) return [];
  const discovered = new Set(input.discovered);
  const sorted = [...unobserved].sort(byCodeUnit);
  const covered = (path: string): boolean => {
    if (sorted.length === 0) return false;
    if (isRepositoryRoot(path) || unobserved.has(path)) return true;
    for (let end = path.indexOf('/'); end !== -1; end = path.indexOf('/', end + 1)) {
      if (unobserved.has(path.slice(0, end))) return true;
    }
    const below = sorted[lowerBound(sorted, `${path}/`)];
    return below !== undefined && below.startsWith(`${path}/`);
  };
  return input.active.filter((path) => !discovered.has(path) && !covered(path));
}
