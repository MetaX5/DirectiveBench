import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import {
  classifyArtifactPath,
  parseArtifactFile,
  type ArtifactClassification,
  type ParsedArtifact,
} from './artifacts';
import { hashManifest, sha256 } from './hash';
import type { ArtifactFile } from './models';

/** Default safety limits of a repository scan (SPEC-102 FR-102-16). */
export const DISCOVERY_LIMITS = {
  /** Largest primary file (`SKILL.md`, `AGENTS.md`, a rule file) in bytes. */
  maxPrimaryFileBytes: 1024 * 1024,
  /** Largest supporting file of a skill in bytes. */
  maxSupportingFileBytes: 5 * 1024 * 1024,
  /** Largest total size of one artifact's files in bytes. */
  maxArtifactBytes: 20 * 1024 * 1024,
  /** Most regular files in one artifact. */
  maxFilesPerArtifact: 500,
  /** Most candidate artifacts in one scan; exceeding it aborts the scan. */
  maxCandidatesPerScan: 10_000,
} as const;

export type DiscoveryLimits = { [K in keyof typeof DISCOVERY_LIMITS]: number };

/** Directory names that are never descended into, at any depth (FR-102-15). */
export const SKIPPED_DIRECTORY_NAMES: readonly string[] = ['.git', 'node_modules'];

/** How many leading bytes are checked for a NUL byte when detecting binary files (FR-102-17). */
export const BINARY_SNIFF_BYTES = 8 * 1024;

export interface SkippedFile {
  /** POSIX path relative to the artifact root. */
  path: string;
  reason: 'symlink' | 'binary';
}

export interface DiscoveredArtifact {
  /** Primary file relative to the scanned root, e.g. `.agents/skills/pdf/SKILL.md`. */
  primaryPath: string;
  /** Where the artifact occurs: the skill directory for skills, else `primaryPath`. */
  occurrencePath: string;
  /** Primary file relative to the artifact root (`SKILL.md` for skills, else the basename). */
  primaryFile: string;
  parsed: ParsedArtifact;
  /** Text files of the artifact, sorted by path. */
  files: ArtifactFile[];
  contentHash: string;
  skipped: SkippedFile[];
  /** Parser warnings followed by discovery warnings (skipped files, root skill). */
  warnings: string[];
}

export interface DiscoveryError {
  /** Primary file relative to the scanned root. */
  path: string;
  code: 'too-large' | 'binary-primary' | 'symlink' | 'too-many-files' | 'read-failed';
  message: string;
}

export interface DiscoveryResult {
  /** Discovered artifacts sorted by `primaryPath`. */
  artifacts: DiscoveredArtifact[];
  /** Per-artifact errors sorted by `path`; an artifact with an error is not in `artifacts`. */
  errors: DiscoveryError[];
  /** Regular files seen by the walk, excluding skipped directories. */
  scannedFiles: number;
}

export interface DiscoveryOptions {
  /** Overrides of {@link DISCOVERY_LIMITS}. */
  limits?: Partial<DiscoveryLimits>;
  /**
   * Aborts the scan: checked before each directory is listed and each candidate is read, so a
   * cancelled or shut-down job stops walking a large tree. The abort reason is thrown.
   */
  signal?: AbortSignal;
}

interface TreeEntry {
  /** POSIX path relative to the scanned root. */
  path: string;
  kind: 'file' | 'symlink';
}

/** Thrown inside one artifact's processing; becomes a {@link DiscoveryError}. */
class ArtifactError extends Error {
  constructor(
    readonly code: DiscoveryError['code'],
    message: string,
  ) {
    super(message);
  }
}

// UTF-16 code-unit order without branches that depend on the listing order (lessons, 2026-10-15).
function byCodeUnit(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/** Lists regular files and symlinks below `root` without following symlinks. */
async function walk(root: string, signal: AbortSignal | undefined): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    signal?.throwIfAborted();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink' });
      } else if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.includes(entry.name)) await visit(join(dir, entry.name), path);
      } else if (entry.isFile()) {
        entries.push({ path, kind: 'file' });
      }
      // Sockets, FIFOs and devices are neither artifacts nor supporting files.
    }
  }
  await visit(root, '');
  return entries.sort((a, b) => byCodeUnit(a.path, b.path));
}

/** The deepest skill directory containing `path`, or `undefined` when none does. */
function owningSkill(path: string, skillRoots: ReadonlySet<string>): string | undefined {
  let dir = posix.dirname(path);
  for (;;) {
    const key = dir === '.' ? '' : dir;
    if (skillRoots.has(key)) return key;
    if (key === '') return undefined;
    dir = posix.dirname(dir);
  }
}

/**
 * Returns the file's bytes, or its size when it is larger than `maxBytes` (nothing is read then).
 * The file is opened with `O_NOFOLLOW`, so a file replaced by a symlink after the walk is not
 * followed, and only the size reported by `fstat` is read, so a file growing during the scan
 * cannot exhaust memory.
 */
async function readUpTo(abs: string, maxBytes: number): Promise<Buffer | number> {
  const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) return size;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readBounded(abs: string, relPath: string, maxBytes: number): Promise<Buffer> {
  const result = await readUpTo(abs, maxBytes).catch((error: unknown) => {
    throw new ArtifactError('read-failed', `Cannot read ${relPath}: ${String(error)}`);
  });
  if (typeof result === 'number') {
    throw new ArtifactError(
      'too-large',
      `${relPath} is ${result} bytes, larger than the limit of ${maxBytes} bytes`,
    );
  }
  return result;
}

/**
 * A NUL byte in the first {@link BINARY_SNIFF_BYTES} bytes, or invalid UTF-8 (FR-102-17). Text
 * files are valid UTF-8, so their decoded `content` re-encodes to exactly the source bytes.
 */
export function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0) || !isUtf8(bytes);
}

function toFile(path: string, bytes: Buffer): ArtifactFile {
  return { path, sha256: sha256(bytes), size: bytes.length, content: bytes.toString('utf8') };
}

async function readPrimary(
  root: string,
  primaryPath: string,
  limits: DiscoveryLimits,
): Promise<Buffer> {
  const bytes = await readBounded(join(root, primaryPath), primaryPath, limits.maxPrimaryFileBytes);
  if (isBinary(bytes)) {
    throw new ArtifactError('binary-primary', `${primaryPath} is not a UTF-8 text file`);
  }
  return bytes;
}

async function discoverSkill(
  root: string,
  primaryPath: string,
  skillDir: string,
  owned: readonly TreeEntry[],
  limits: DiscoveryLimits,
): Promise<DiscoveredArtifact> {
  const regularFiles = owned.filter((entry) => entry.kind === 'file');
  if (regularFiles.length > limits.maxFilesPerArtifact) {
    throw new ArtifactError(
      'too-many-files',
      `Skill ${primaryPath} has ${regularFiles.length} files, more than the limit of ${limits.maxFilesPerArtifact}`,
    );
  }
  const prefix = skillDir ? `${skillDir}/` : '';
  const primaryBytes = await readPrimary(root, primaryPath, limits);
  const parsed = parseArtifactFile(primaryPath, primaryBytes.toString('utf8'));
  const warnings = [...parsed.warnings];
  if (skillDir === '') {
    warnings.push('SKILL.md is at the scan root: the whole tree is collected as one skill');
  }
  const files: ArtifactFile[] = [];
  const skipped: SkippedFile[] = [];
  let total = 0;
  for (const entry of owned) {
    const path = entry.path.slice(prefix.length);
    if (entry.kind === 'symlink') {
      skipped.push({ path, reason: 'symlink' });
      warnings.push(`Skipped symbolic link ${path}`);
      continue;
    }
    const bytes =
      entry.path === primaryPath
        ? primaryBytes
        : await readBounded(join(root, entry.path), entry.path, limits.maxSupportingFileBytes);
    if (isBinary(bytes)) {
      skipped.push({ path, reason: 'binary' });
      warnings.push(`Skipped binary file ${path}`);
      continue;
    }
    total += bytes.length;
    if (total > limits.maxArtifactBytes) {
      throw new ArtifactError(
        'too-large',
        `Skill ${primaryPath} is larger than the limit of ${limits.maxArtifactBytes} bytes`,
      );
    }
    files.push(toFile(path, bytes));
  }
  return {
    primaryPath,
    occurrencePath: skillDir,
    primaryFile: 'SKILL.md',
    parsed,
    files,
    contentHash: hashManifest(files),
    skipped,
    warnings,
  };
}

async function discoverSingleFile(
  root: string,
  primaryPath: string,
  limits: DiscoveryLimits,
): Promise<DiscoveredArtifact> {
  const bytes = await readPrimary(root, primaryPath, limits);
  const parsed = parseArtifactFile(primaryPath, bytes.toString('utf8'));
  const primaryFile = posix.basename(primaryPath);
  const files = [toFile(primaryFile, bytes)];
  return {
    primaryPath,
    occurrencePath: primaryPath,
    primaryFile,
    parsed,
    files,
    contentHash: hashManifest(files),
    skipped: [],
    warnings: [...parsed.warnings],
  };
}

/**
 * Discovers every supported artifact below a registered local root (SPEC-102 FR-102-12…20).
 *
 * Discovery is read-only: files are read as bytes and parsed as text, never executed, imported
 * or spawned, and no git hooks, package scripts or LFS filters run. Symlinks are never followed;
 * `.git/` and `node_modules/` are skipped. A limit violation or unreadable file is a
 * {@link DiscoveryError} for that artifact only; more than `maxCandidatesPerScan` candidates
 * aborts the scan. The result is deterministic for the same tree.
 */
export async function discoverArtifacts(
  root: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const limits: DiscoveryLimits = { ...DISCOVERY_LIMITS, ...options.limits };
  const realRoot = await realpath(resolve(root));
  if (!(await stat(realRoot)).isDirectory()) {
    throw new Error(`Discovery root is not a directory: ${root}`);
  }

  const entries = await walk(realRoot, options.signal);
  const candidates: { entry: TreeEntry; classification: ArtifactClassification }[] = [];
  for (const entry of entries) {
    const classification = classifyArtifactPath(entry.path);
    if (classification) candidates.push({ entry, classification });
  }
  if (candidates.length > limits.maxCandidatesPerScan) {
    throw new Error(
      `Discovery aborted: ${candidates.length} candidate artifacts exceed the limit of ${limits.maxCandidatesPerScan} per scan`,
    );
  }

  const skillRoots = new Set<string>();
  for (const { classification } of candidates) {
    if (classification.rootDir !== null) skillRoots.add(classification.rootDir);
  }
  const owners = entries.map((entry) => owningSkill(entry.path, skillRoots));

  const artifacts: DiscoveredArtifact[] = [];
  const errors: DiscoveryError[] = [];
  for (const { entry, classification } of candidates) {
    options.signal?.throwIfAborted();
    try {
      if (entry.kind === 'symlink') {
        throw new ArtifactError('symlink', `${entry.path} is a symbolic link and is not followed`);
      }
      artifacts.push(
        classification.rootDir === null
          ? await discoverSingleFile(realRoot, entry.path, limits)
          : await discoverSkill(
              realRoot,
              entry.path,
              classification.rootDir,
              // Every file and symlink whose deepest enclosing skill is this one (FR-102-12).
              entries.filter((_, index) => owners[index] === classification.rootDir),
              limits,
            ),
      );
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      errors.push({ path: entry.path, code: error.code, message: error.message });
    }
  }

  return {
    artifacts,
    errors,
    scannedFiles: entries.filter((entry) => entry.kind === 'file').length,
  };
}
