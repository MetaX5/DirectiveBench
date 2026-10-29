import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { hashManifest, type ManifestEntry } from '@directivebench/core';

export interface FileLimits {
  maxFiles: number;
  maxTotalBytes: number;
}

export const DEFAULT_FILE_LIMITS: FileLimits = { maxFiles: 5000, maxTotalBytes: 100 * 1024 * 1024 };

export class UnsafeFileError extends Error {
  override name = 'UnsafeFileError';
}

export interface ManifestFile extends ManifestEntry {
  size: number;
}

/**
 * sha256 of the first `size` bytes of a file, the size `lstat` reported. At most one byte more is
 * read: a file that grew meanwhile is refused, so a writer cannot make the walk read without bound
 * past the manifest's byte limit (SPEC-123 Codex review round 2).
 */
async function sha256File(path: string, size: number, relPath: string): Promise<string> {
  const hash = createHash('sha256');
  let read = 0;
  // `end` is inclusive: bytes 0..size, i.e. the file plus a one-byte growth probe.
  for await (const chunk of createReadStream(path, { start: 0, end: size })) {
    read += (chunk as Buffer).length;
    if (read > size) throw new UnsafeFileError(`File changed while it was read: ${relPath}`);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Lists regular files below `root` with their hashes. Symlinks and special files are rejected:
 * they could point outside the fixture or the workspace.
 */
export async function buildManifest(
  root: string,
  options: { limits?: FileLimits; ignore?: (relPath: string) => boolean } = {},
): Promise<ManifestFile[]> {
  const limits = options.limits ?? DEFAULT_FILE_LIMITS;
  const files: ManifestFile[] = [];
  let totalBytes = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (options.ignore?.(rel)) continue;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new UnsafeFileError(`Symbolic links are not allowed: ${rel}`);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const info = await lstat(abs);
        totalBytes += info.size;
        if (files.length + 1 > limits.maxFiles) {
          throw new UnsafeFileError(`More than ${limits.maxFiles} files in ${root}`);
        }
        if (totalBytes > limits.maxTotalBytes) {
          throw new UnsafeFileError(`More than ${limits.maxTotalBytes} bytes in ${root}`);
        }
        files.push({ path: rel, sha256: await sha256File(abs, info.size, rel), size: info.size });
      } else {
        throw new UnsafeFileError(`Unsupported file type: ${rel}`);
      }
    }
  }

  await walk(root, '');
  return files;
}

/** Copies a directory tree file by file, rejecting symlinks and special files. */
export async function copyTree(source: string, destination: string): Promise<void> {
  const manifest = await buildManifest(source);
  await mkdir(destination, { recursive: true });
  for (const file of manifest) {
    const target = join(destination, file.path);
    await mkdir(join(target, '..'), { recursive: true });
    await copyFile(join(source, file.path), target);
  }
}

export interface Snapshot {
  hash: string;
  dir: string;
  fileCount: number;
  totalBytes: number;
}

/**
 * Stores an immutable, content-addressed copy of `source` in `storeRoot/<sha256>`. Identical
 * content is stored once. Writes go to a temporary directory that is renamed atomically.
 */
export async function snapshotDirectory(source: string, storeRoot: string): Promise<Snapshot> {
  const info = await stat(source).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Fixture directory not found: ${source}`);
  const manifest = await buildManifest(source);
  if (manifest.length === 0) throw new Error(`Fixture directory is empty: ${source}`);
  const hash = hashManifest(manifest);
  const dir = join(storeRoot, hash);
  const result = {
    hash,
    dir,
    fileCount: manifest.length,
    totalBytes: manifest.reduce((sum, f) => sum + f.size, 0),
  };
  if (await stat(dir).catch(() => null)) return result;
  await mkdir(storeRoot, { recursive: true });
  const tmp = join(storeRoot, `.tmp-${hash.slice(0, 12)}-${randomBytes(4).toString('hex')}`);
  try {
    await copyTree(source, tmp);
    await rename(tmp, dir);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    // A concurrent import may have stored the same snapshot first.
    if (await stat(dir).catch(() => null)) return result;
    throw error;
  }
  return result;
}

export type FileChange = { path: string; change: 'added' | 'modified' | 'deleted' };

export function diffManifests(
  before: readonly ManifestEntry[],
  after: readonly ManifestEntry[],
): FileChange[] {
  const previous = new Map(before.map((f) => [f.path, f.sha256]));
  const next = new Map(after.map((f) => [f.path, f.sha256]));
  const changes: FileChange[] = [];
  for (const [path, hash] of next) {
    const old = previous.get(path);
    if (old === undefined) changes.push({ path, change: 'added' });
    else if (old !== hash) changes.push({ path, change: 'modified' });
  }
  for (const path of previous.keys()) {
    if (!next.has(path)) changes.push({ path, change: 'deleted' });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}
