import { Buffer, isUtf8 } from 'node:buffer';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import {
  classifyArtifactPath,
  parseArtifactFile,
  type ArtifactClassification,
  type ParsedArtifact,
} from './artifacts';
import { hashManifest, sha256 } from './hash';
import type { ArtifactFile } from './models';
import { pathRelation } from './repository-path';

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
  /**
   * Most bytes one scan keeps for its artifacts: their file content plus their parsed frontmatter
   * as JSON (stored next to it). Exceeding it aborts the scan.
   * `discoverArtifacts` returns every artifact's contents at once, so without this cap the other
   * limits allow 10 000 × 20 MiB. 256 MiB is far above real agent-instruction repositories
   * (typically well under 10 MiB of text) and room for a dozen maximal skills, while the runner,
   * which holds the contents again as strings and query parameters when it stores them, stays
   * within the memory of an ordinary development machine.
   */
  maxScanBytes: 256 * 1024 * 1024,
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
  /**
   * Primary file relative to the scanned root — or, for a `read-failed` directory that lies outside
   * every skill, that directory. A skill with an unreadable or changed directory inside it is an
   * error for its `SKILL.md`: an artifact is discovered completely or not at all.
   */
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
  /**
   * Directories of {@link DiscoveryOptions.skipDirectories} the walk met and did not enter, as
   * POSIX paths relative to the root, sorted; `.` when the root itself is one of them or lies
   * inside one (nothing is read then). Not errors.
   */
  skippedDirectories: string[];
}

export interface DiscoveryOptions {
  /** Overrides of {@link DISCOVERY_LIMITS}. */
  limits?: Partial<DiscoveryLimits>;
  /**
   * Aborts the scan: checked before each directory is listed and each candidate is read, so a
   * cancelled or shut-down job stops walking a large tree. The abort reason is thrown.
   */
  signal?: AbortSignal;
  /**
   * The canonical path the root must resolve to, e.g. a registered repository's stored location.
   * When the root resolves elsewhere (it was replaced by a symlink or moved), nothing is read and
   * a {@link DiscoveryRootChangedError} is thrown.
   */
  expectedRoot?: string;
  /**
   * Canonical absolute directories that are never entered, wherever they occur below the root —
   * the agents' user-level folders such as `~/.claude` (product decision D05). A root equal to or
   * inside one of them is not read at all.
   */
  skipDirectories?: readonly string[];
}

/** The discovery root no longer resolves to the expected canonical path. */
export class DiscoveryRootChangedError extends Error {
  override name = 'DiscoveryRootChangedError';
}

/** A per-scan limit of {@link DISCOVERY_LIMITS} was exceeded: the whole scan is aborted. */
export class DiscoveryLimitError extends Error {
  override name = 'DiscoveryLimitError';
  constructor(
    readonly limit: 'maxCandidatesPerScan' | 'maxScanBytes',
    message: string,
  ) {
    super(message);
  }
}

/** A regular file or symlink of a repository tree: on disk, or listed from a git commit. */
export interface RepositoryTreeEntry {
  /** POSIX path relative to the scanned root. */
  path: string;
  kind: 'file' | 'symlink';
}
type TreeEntry = RepositoryTreeEntry;

/** Reads one file for an artifact; throws an {@link ArtifactError} for that artifact only. */
type ReadFile = (path: string, maxBytes: number) => Promise<Buffer>;

/** A directory the walk could not list, or that changed during the scan. */
interface UnreadableDirectory {
  /** POSIX path relative to the scanned root. */
  path: string;
  message: string;
}

/** What belongs to one skill: the entries and unreadable directories it is the deepest skill of. */
interface SkillContents {
  owned: TreeEntry[];
  unreadable: UnreadableDirectory[];
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

/**
 * Lists regular files and symlinks below `root` without following symlinks. A subdirectory that
 * cannot be listed (permissions, removed during the walk) or that changed during the scan is
 * returned in `unreadable` and the walk continues; an unreadable root is rethrown.
 */
async function walk(
  root: string,
  signal: AbortSignal | undefined,
  skipDirectories: ReadonlySet<string>,
): Promise<{ entries: TreeEntry[]; unreadable: UnreadableDirectory[]; skipped: string[] }> {
  const entries: TreeEntry[] = [];
  const unreadable: UnreadableDirectory[] = [];
  const skipped: string[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    signal?.throwIfAborted();
    let listing;
    try {
      // `dir` was a directory when its parent was listed. If it has been replaced by a symlink
      // (or a parent has) since, it no longer resolves to itself and is not entered (FR-102-18).
      if (prefix !== '' && (await realpath(dir)) !== dir) {
        unreadable.push({
          path: prefix,
          message: `Directory ${prefix} changed during the scan and no longer resolves inside the scanned root; its files were not scanned`,
        });
        return;
      }
      listing = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (prefix === '') throw error;
      unreadable.push({
        path: prefix,
        message: `Cannot read directory ${prefix} (${errorCode(error)}); its files were not scanned`,
      });
      return;
    }
    for (const entry of listing) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink' });
      } else if (entry.isDirectory()) {
        const abs = join(dir, entry.name);
        if (skipDirectories.has(abs)) skipped.push(path);
        else if (!SKIPPED_DIRECTORY_NAMES.includes(entry.name)) await visit(abs, path);
      } else if (entry.isFile()) {
        entries.push({ path, kind: 'file' });
      }
      // Sockets, FIFOs and devices are neither artifacts nor supporting files.
    }
  }
  await visit(root, '');
  return {
    entries: entries.sort((a, b) => byCodeUnit(a.path, b.path)),
    unreadable: unreadable.sort((a, b) => byCodeUnit(a.path, b.path)),
    skipped: skipped.sort(byCodeUnit),
  };
}

/** The error's `code` (`EACCES`, `ENOENT`, …): messages never carry the absolute path. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/**
 * The contents of the deepest skill whose directory is `dir` or one of its ancestors, or
 * `undefined` when none is. `dir` is relative to the scanned root (`''` or `.` for the root).
 */
function owningSkill(
  dir: string,
  skills: ReadonlyMap<string, SkillContents>,
): SkillContents | undefined {
  let key = dir === '.' ? '' : dir;
  for (;;) {
    const contents = skills.get(key);
    if (contents) return contents;
    if (key === '') return undefined;
    const parent = posix.dirname(key);
    key = parent === '.' ? '' : parent;
  }
}

/**
 * File IDs that identify nothing: 0 on a file system without inodes, and all ones, which Windows
 * reports for an invalid or unknown ReFS file ID. Identity cannot be proven with them.
 */
const UNKNOWN_FILE_IDS: readonly bigint[] = [0n, 0xffff_ffff_ffff_ffffn];

/**
 * The opened handle and the path are the same regular file: both are on the same device with the
 * same inode, and the path is not a symlink (Node reports Windows junctions as symlinks too). A
 * symlink has an inode of its own, so the inode comparison already rejects one; the symlink check
 * stays as defence in depth, should a platform report a link with its target's ID.
 */
function isSameRegularFile(opened: BigIntStats, path: BigIntStats): boolean {
  return (
    opened.isFile() && !path.isSymbolicLink() && opened.ino === path.ino && opened.dev === path.dev
  );
}

/**
 * Returns the file's bytes, or its size when it is larger than `maxBytes` (nothing is read then).
 * Only the size reported by `fstat` is read, so a file growing during the scan cannot exhaust
 * memory.
 *
 * The walk saw a regular file at `abs`, but it may have been replaced since by a symlink (on
 * Windows also a junction or another reparse point). `O_NOFOLLOW` makes the open itself refuse a
 * symlink in the last path component where the platform has the flag (Linux, macOS); Windows has
 * none (`constants.O_NOFOLLOW` is undefined) and its open follows the link. So, on every platform,
 * the handle (`fstat`) and the path (`lstat`, after the open) must be the same regular file —
 * neither a symlink nor a different device and inode — or the read fails (FR-102-18). A link
 * swapped in before the open makes the handle refer to the link's target: `lstat` then reports a
 * symlink, and if the attacker swaps the original file back right after the open, the path is a
 * regular file again but the handle still refers to the target, which the inode comparison
 * catches. A file system that reports no usable file ID ({@link UNKNOWN_FILE_IDS}) cannot prove
 * identity, so the read fails closed there. A swap after the `lstat` cannot redirect the read: the
 * handle is already open.
 *
 * `O_NONBLOCK` (where defined; regular files ignore it) keeps a FIFO swapped in before the open
 * from blocking the open until a writer appears; the identity check then rejects it. Windows has
 * no `O_NONBLOCK`, and its named pipes live in their own namespace (`\\.\pipe\`), not in a
 * directory where they could replace a walked file.
 */
async function readUpTo(abs: string, relPath: string, maxBytes: number): Promise<Buffer | number> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(abs, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (UNKNOWN_FILE_IDS.includes(opened.ino)) {
      throw new ArtifactError(
        'read-failed',
        `Cannot read ${relPath}: its file identity cannot be verified on this file system`,
      );
    }
    if (!isSameRegularFile(opened, await lstat(abs, { bigint: true }))) {
      throw new ArtifactError(
        'read-failed',
        `Cannot read ${relPath}: it changed during the scan and is no longer the regular file the walk found`,
      );
    }
    const size = Number(opened.size);
    if (size > maxBytes) return size;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Reads a file found by the walk. Its directory must still resolve to itself: the identity check
 * of {@link readUpTo} covers only the last path component, so a directory swapped for a symlink
 * after the walk would otherwise redirect the read outside the root (FR-102-18).
 */
async function readBounded(abs: string, relPath: string, maxBytes: number): Promise<Buffer> {
  let result: Buffer | number;
  try {
    const parent = dirname(abs);
    if ((await realpath(parent)) !== parent) {
      throw new ArtifactError(
        'read-failed',
        `Cannot read ${relPath}: its directory changed during the scan and no longer resolves inside the scanned root`,
      );
    }
    result = await readUpTo(abs, relPath, maxBytes);
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError('read-failed', `Cannot read ${relPath} (${errorCode(error)})`);
  }
  return withinLimit(result, relPath, maxBytes);
}

/** The bytes, or a `too-large` error for a file whose size alone was reported. */
function withinLimit(result: Buffer | number, relPath: string, maxBytes: number): Buffer {
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
  read: ReadFile,
  primaryPath: string,
  limits: DiscoveryLimits,
): Promise<Buffer> {
  const bytes = await read(primaryPath, limits.maxPrimaryFileBytes);
  if (isBinary(bytes)) {
    throw new ArtifactError('binary-primary', `${primaryPath} is not a UTF-8 text file`);
  }
  return bytes;
}

/** Throws once keeping `adding` more bytes would exceed `maxScanBytes` (FR-102-16). */
function checkScanBytes(retained: number, adding: number, limits: DiscoveryLimits): void {
  if (retained + adding > limits.maxScanBytes) {
    throw new DiscoveryLimitError(
      'maxScanBytes',
      `Discovery aborted: the discovered artifacts exceed the limit of ${limits.maxScanBytes} bytes per scan`,
    );
  }
}

async function discoverSkill(
  read: ReadFile,
  primaryPath: string,
  skillDir: string,
  contents: SkillContents,
  limits: DiscoveryLimits,
  retained: number,
): Promise<DiscoveredArtifact> {
  // A skill missing part of its tree would be stored as a new, incomplete version (FR-102-12).
  const [unreadable, ...more] = contents.unreadable;
  if (unreadable) {
    const others =
      more.length === 0
        ? ''
        : ` (and ${more.length} more ${more.length === 1 ? 'directory' : 'directories'})`;
    throw new ArtifactError(
      'read-failed',
      `Skill ${primaryPath} is incomplete and was not discovered. ${unreadable.message}${others}`,
    );
  }
  const owned = contents.owned;
  const regularFiles = owned.filter((entry) => entry.kind === 'file');
  if (regularFiles.length > limits.maxFilesPerArtifact) {
    throw new ArtifactError(
      'too-many-files',
      `Skill ${primaryPath} has ${regularFiles.length} files, more than the limit of ${limits.maxFilesPerArtifact}`,
    );
  }
  const prefix = skillDir ? `${skillDir}/` : '';
  const primaryBytes = await readPrimary(read, primaryPath, limits);
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
        : await read(entry.path, limits.maxSupportingFileBytes);
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
    checkScanBytes(retained, total, limits);
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
  read: ReadFile,
  primaryPath: string,
  limits: DiscoveryLimits,
  retained: number,
): Promise<DiscoveredArtifact> {
  const bytes = await readPrimary(read, primaryPath, limits);
  checkScanBytes(retained, bytes.length, limits);
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
 * `.git/`, `node_modules/` and the `skipDirectories` are skipped. Before a directory is listed or
 * a file is opened, its directory must still resolve to itself, so a directory swapped for a
 * symlink during the scan is a `read-failed` error, not a way out of the root; a swap landing
 * between that check and the read itself is not detected (Node has no `openat`). An opened file
 * must still be the regular file the walk found, on every platform (see `readUpTo`).
 *
 * An artifact is discovered completely or not at all: a limit violation, an unreadable file, or an
 * unreadable or changed directory inside a skill is a {@link DiscoveryError} for that artifact
 * only, and the artifact is not returned. An unreadable directory outside every skill is an error
 * of its own. More than `maxCandidatesPerScan` candidates, or more than `maxScanBytes` of content
 * and frontmatter JSON kept, aborts the scan with a {@link DiscoveryLimitError}. The result is
 * deterministic for the same tree.
 */
export async function discoverArtifacts(
  root: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const limits: DiscoveryLimits = { ...DISCOVERY_LIMITS, ...options.limits };
  const realRoot = await realpath(resolve(root));
  if (options.expectedRoot !== undefined && realRoot !== options.expectedRoot) {
    throw new DiscoveryRootChangedError(
      `Discovery root ${root} resolves to ${realRoot}, not ${options.expectedRoot}`,
    );
  }
  if (!(await stat(realRoot)).isDirectory()) {
    throw new Error(`Discovery root is not a directory: ${root}`);
  }
  const skipDirectories = new Set(options.skipDirectories ?? []);
  const insideSkipped = (dir: string) => ['same', 'inside'].includes(pathRelation(realRoot, dir));
  if ([...skipDirectories].some(insideSkipped)) {
    return { artifacts: [], errors: [], scannedFiles: 0, skippedDirectories: ['.'] };
  }

  const listing = await walk(realRoot, options.signal, skipDirectories);
  return discoverListing(
    listing,
    (path, maxBytes) => readBounded(join(realRoot, path), path, maxBytes),
    limits,
    options.signal,
  );
}

interface TreeListing {
  /** Sorted by path. */
  entries: TreeEntry[];
  unreadable: UnreadableDirectory[];
  skipped: string[];
}

interface CandidatePlan {
  candidates: {
    entry: TreeEntry;
    classification: ArtifactClassification;
    /** Skills: what this is the deepest enclosing skill of (FR-102-12). */
    contents: SkillContents;
  }[];
  /** Unreadable directories outside every skill. */
  errors: DiscoveryError[];
}

/**
 * Classifies the tree (SPEC-102 FR-102-01, FR-102-12): the candidate artifacts and, for each
 * skill, the entries and unreadable directories it is the deepest skill of. More than
 * `maxCandidatesPerScan` candidates aborts with a {@link DiscoveryLimitError} before anything is
 * read.
 */
function planCandidates(
  entries: readonly TreeEntry[],
  unreadable: readonly UnreadableDirectory[],
  limits: DiscoveryLimits,
): CandidatePlan {
  const candidates: CandidatePlan['candidates'] = [];
  for (const entry of entries) {
    const classification = classifyArtifactPath(entry.path);
    if (classification) {
      candidates.push({ entry, classification, contents: { owned: [], unreadable: [] } });
    }
  }
  if (candidates.length > limits.maxCandidatesPerScan) {
    throw new DiscoveryLimitError(
      'maxCandidatesPerScan',
      `Discovery aborted: ${candidates.length} candidate artifacts exceed the limit of ${limits.maxCandidatesPerScan} per scan`,
    );
  }

  const skills = new Map<string, SkillContents>();
  for (const { classification, contents } of candidates) {
    if (classification.rootDir !== null) skills.set(classification.rootDir, contents);
  }
  for (const entry of entries) {
    owningSkill(posix.dirname(entry.path), skills)?.owned.push(entry);
  }
  const errors: DiscoveryError[] = [];
  for (const dir of unreadable) {
    const owner = owningSkill(dir.path, skills);
    if (owner) owner.unreadable.push(dir);
    else errors.push({ path: dir.path, code: 'read-failed', message: dir.message });
  }
  return { candidates, errors };
}

async function discoverListing(
  listing: TreeListing,
  read: ReadFile,
  limits: DiscoveryLimits,
  signal: AbortSignal | undefined,
): Promise<DiscoveryResult> {
  const { entries, unreadable, skipped } = listing;
  const { candidates, errors } = planCandidates(entries, unreadable, limits);
  const artifacts: DiscoveredArtifact[] = [];
  /** Bytes of file content and frontmatter JSON held by `artifacts` (FR-102-16 `maxScanBytes`). */
  let retained = 0;
  for (const { entry, classification, contents } of candidates) {
    signal?.throwIfAborted();
    try {
      if (entry.kind === 'symlink') {
        throw new ArtifactError('symlink', `${entry.path} is a symbolic link and is not followed`);
      }
      const artifact =
        classification.rootDir === null
          ? await discoverSingleFile(read, entry.path, limits, retained)
          : await discoverSkill(
              read,
              entry.path,
              classification.rootDir,
              contents,
              limits,
              retained,
            );
      // The parsed frontmatter is stored as JSON next to the files, with its aliases expanded, so
      // it counts too: each file's is capped (MAX_FRONTMATTER_JSON_BYTES), not their total.
      const kept =
        artifact.files.reduce((sum, file) => sum + file.size, 0) +
        Buffer.byteLength(JSON.stringify(artifact.parsed.frontmatter));
      checkScanBytes(retained, kept, limits);
      artifacts.push(artifact);
      retained += kept;
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      errors.push({ path: entry.path, code: error.code, message: error.message });
    }
  }

  return {
    artifacts,
    errors: errors.sort((a, b) => byCodeUnit(a.path, b.path)),
    scannedFiles: entries.filter((entry) => entry.kind === 'file').length,
    skippedDirectories: skipped,
  };
}

/** A path as a git tree lists it: relative, `/`-separated, without empty, `.` or `..` segments. */
function isNormalisedTreePath(path: string): boolean {
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * The entries of a listed tree (a git commit) as the walk would see them: entries below a
 * `.git/` or `node_modules/` directory dropped (FR-102-15), sorted by path. A path that is not
 * normalised is rejected, so a crafted tree cannot smuggle `..` into an occurrence path.
 */
function treeListing(entries: readonly RepositoryTreeEntry[]): TreeListing {
  const kept: TreeEntry[] = [];
  for (const entry of entries) {
    if (!isNormalisedTreePath(entry.path)) {
      throw new Error(`The repository tree lists a path that is not normalised: ${entry.path}`);
    }
    const directories = entry.path.split('/').slice(0, -1);
    if (!directories.some((name) => SKIPPED_DIRECTORY_NAMES.includes(name))) {
      kept.push({ path: entry.path, kind: entry.kind });
    }
  }
  return {
    entries: kept.sort((a, b) => byCodeUnit(a.path, b.path)),
    unreadable: [],
    skipped: [],
  };
}

/**
 * The regular files whose content discovery of this tree reads (SPEC-105 §9.1 step 3): the
 * primary file of every candidate artifact and, for each skill, the regular files it owns
 * (FR-102-12, nested skills excluded). Symlinks are never read, and a skill with more than
 * `maxFilesPerArtifact` files is an error without reading any of them. More than
 * `maxCandidatesPerScan` candidates aborts with a {@link DiscoveryLimitError}, before anything is
 * downloaded. Sorted, without duplicates.
 */
export function selectCandidateFiles(
  entries: readonly RepositoryTreeEntry[],
  options: { limits?: Partial<DiscoveryLimits> } = {},
): string[] {
  const limits: DiscoveryLimits = { ...DISCOVERY_LIMITS, ...options.limits };
  const { candidates } = planCandidates(treeListing(entries).entries, [], limits);
  const paths = new Set<string>();
  for (const { entry, classification, contents } of candidates) {
    if (entry.kind === 'symlink') continue;
    if (classification.rootDir === null) {
      paths.add(entry.path);
      continue;
    }
    const files = contents.owned.filter((owned) => owned.kind === 'file');
    if (files.length > limits.maxFilesPerArtifact) continue;
    for (const file of files) paths.add(file.path);
  }
  return [...paths].sort(byCodeUnit);
}

/**
 * A file of a listed tree that was read and found binary ({@link isBinary}), given by its size
 * alone: its bytes were dropped right after reading, since discovery never keeps a binary file.
 */
export interface BinaryTreeFile {
  binary: true;
  size: number;
}

/** What discovery sees of a binary file within its limit: one NUL byte, which {@link isBinary} flags. */
const BINARY_STAND_IN = Buffer.from([0]);

/**
 * Discovers the artifacts of a listed tree — a git commit of a hosted repository — with exactly
 * the rules of {@link discoverArtifacts} (formats, skill directories, skipped directories,
 * symlinks, binary files, limits), reading file contents from `contents` instead of the disk.
 * `contents` maps each path {@link selectCandidateFiles} returned to its bytes as committed, to
 * its size alone when it was too large to load, or to a {@link BinaryTreeFile} when it was read
 * and found binary; a file larger than the limit that applies to it is a `too-large` error in
 * every form, as on disk, where the size is checked before the content. A selected file missing
 * from `contents`, or one given only by a size within its limit, fails the whole discovery: its
 * content was never read.
 */
export async function discoverArtifactsInTree(
  entries: readonly RepositoryTreeEntry[],
  contents: ReadonlyMap<string, Buffer | number | BinaryTreeFile>,
  options: { limits?: Partial<DiscoveryLimits>; signal?: AbortSignal } = {},
): Promise<DiscoveryResult> {
  const limits: DiscoveryLimits = { ...DISCOVERY_LIMITS, ...options.limits };
  const read: ReadFile = async (path, maxBytes) => {
    const content = contents.get(path);
    if (content === undefined || (typeof content === 'number' && content <= maxBytes)) {
      throw new Error(`The content of ${path} was not provided`);
    }
    if (typeof content === 'number') return withinLimit(content, path, maxBytes);
    if (Buffer.isBuffer(content)) {
      return withinLimit(content.length > maxBytes ? content.length : content, path, maxBytes);
    }
    return withinLimit(content.size > maxBytes ? content.size : BINARY_STAND_IN, path, maxBytes);
  };
  return discoverListing(treeListing(entries), read, limits, options.signal);
}
