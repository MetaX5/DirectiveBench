import { createHash, randomBytes } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface ManifestEntry {
  /** POSIX-style relative path. */
  path: string;
  sha256: string;
}

/**
 * Content hash for a set of files: independent of file order and of file metadata.
 * Two directories with identical relative paths and bytes always hash identically.
 */
export function hashManifest(entries: readonly ManifestEntry[]): string {
  const lines = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => `${entry.path}\0${entry.sha256}`);
  return sha256(lines.join('\n'));
}

/** Stable JSON serialisation (sorted object keys) used for content hashes of structured data. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        // Object keys are unique, so two keys never compare equal.
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Prefixed random identifier, e.g. `art_3kq9…`. */
export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
