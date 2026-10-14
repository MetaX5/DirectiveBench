import { isAbsolute, relative, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  override name = 'PathEscapeError';
}

/** Resolves a relative path inside `root`, rejecting absolute paths and `..` escapes. */
export function resolveInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new PathEscapeError(`Path must be relative: ${relativePath}`);
  }
  const base = resolve(root);
  const target = resolve(base, relativePath);
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathEscapeError(`Path escapes the workspace: ${relativePath}`);
  }
  return target;
}
