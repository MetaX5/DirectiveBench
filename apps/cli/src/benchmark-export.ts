import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { MOCK_AGENT_ID, resolveInside } from '@directivebench/agent-adapters';
import {
  getAgentRunFile,
  getBenchmarkRunDetail,
  listAgentRunFiles,
  type AgentRunFileSummary,
  type BenchmarkRunDetail,
  type Database,
} from '@directivebench/database';
import { CliError, ExitCode, resolveAssets } from './runtime';
import { openInitializedDatabase } from './setup';

export interface BenchmarkExportFlags {
  runId: string;
  out: string;
  json?: boolean;
  dataDir?: string;
}

/** Version of the `manifest.json` layout below; bumped on an incompatible change. */
export const EXPORT_MANIFEST_VERSION = 1;

/** Why a kept file was not written (SPEC-123 FR-123-42). */
export type ExportSkipReason = 'unsafe-path' | 'path-collision';

export interface ExportedFile {
  path: string;
  change: AgentRunFileSummary['change'];
  sizeBytes: number | null;
  sha256: string | null;
  kept: AgentRunFileSummary['kept'];
  /** Why the content was cut or not kept at capture time (FR-123-05, FR-123-08). */
  reason: AgentRunFileSummary['reason'];
  redactions: number;
  /** Where the content was written, relative to the export directory; null when not written. */
  exportedTo: string | null;
  /** Why kept content was not written; null when it was written or nothing was kept. */
  exportReason: ExportSkipReason | null;
}

export interface ExportedAgentRun {
  caseId: string;
  variant: 'baseline' | 'candidate';
  repetition: number;
  executionStatus: string;
  outputFilesKept: boolean;
  outputFilesReason: string | null;
  files: ExportedFile[];
}

export interface ExportSummary {
  agentRuns: number;
  /** Changed files listed, written or not. */
  files: number;
  written: number;
  truncated: number;
  notKept: number;
  unsafePath: number;
  pathCollision: number;
}

export interface ExportManifest {
  manifestVersion: typeof EXPORT_MANIFEST_VERSION;
  runId: string;
  status: string;
  suite: { id: string; name: string; version: number };
  candidate: { artifact: string; version: number };
  baseline: { kind: 'none' } | { kind: 'artifact-version'; version: number };
  agent: { adapterId: string; version: string | null; mock: boolean };
  agentRuns: ExportedAgentRun[];
  summary: ExportSummary;
}

/**
 * Characters no Windows file name may hold, plus control characters; `:` also covers drive
 * prefixes and NTFS alternate data streams (`file:stream`).
 */
// eslint-disable-next-line no-control-regex
const NON_PORTABLE_CHARACTERS = /[\u0000-\u001f<>:"|?*\\]/;
/** Device names Windows reserves in every directory, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * A stored path is untrusted (SPEC-123 FR-123-42): it must be a relative POSIX path whose
 * segments are not empty, `.` or `..`, with no NUL, no backslash and no drive or UNC prefix.
 * Stricter, so an export means the same on every platform: no segment may hold a character
 * Windows forbids (`<>:"|?*`, control characters), end in a dot or a space (Windows drops them, so
 * two names would meet) or be a reserved device name (`CON`, `nul.txt`, …).
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || NON_PORTABLE_CHARACTERS.test(path)) {
    return false;
  }
  return path
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        !/[. ]$/.test(segment) &&
        !WINDOWS_DEVICE_NAME.test(segment),
    );
}

function errorCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException).code;
}

/** A directory entry's identity: the same `dev` and `ino` means the same file or directory. */
interface Identity {
  dev: number;
  ino: number;
}

const identityOf = (stats: Stats): Identity => ({ dev: stats.dev, ino: stats.ino });

/** Raised when a path of the export no longer names what the export created or checked there. */
class ExportChangedError extends Error {
  override name = 'ExportChangedError';
  constructor(path: string) {
    super(
      `${path} was replaced or moved while the export was writing, so it stopped without writing into it`,
    );
  }
}

/** The export directory, once it is the working directory (see `enterTarget`). */
const HERE = '.';
const FILES_DIR = 'files';
const MANIFEST_FILE = 'manifest.json';
/** Exported files and directories are private to the user, like the data directory. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
/** POSIX permission bits that let the group or others add, rename or remove entries. */
const GROUP_OR_OTHER_WRITE = 0o022;

/**
 * The export directory and every directory created below it, by path relative to the export
 * directory, with the identity each had when it was checked or created. Before content is
 * written, the chain is checked again and the opened file must be the entry its path names, so a
 * directory or file swapped for another one, or for a symbolic link, stops the export before
 * content reaches it (SPEC-123 FR-123-42). Directories this export creates are private (0700) and
 * must be owned by the user, so only the user, who already holds every permission the export has,
 * could swap anything in them.
 */
class ExportTree {
  private readonly dirs = new Map<string, Identity>();

  constructor(hereStats: Stats) {
    this.dirs.set(HERE, identityOf(hereStats));
  }

  has(path: string): boolean {
    return this.dirs.has(path);
  }

  /**
   * Records a directory this export has just created. It must be a directory owned by the current
   * user (POSIX), so one put in its place between `mkdir` and this check is refused.
   */
  async record(path: string): Promise<void> {
    const stats = await lstat(path);
    const uid = process.getuid?.();
    if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
      throw new ExportChangedError(path);
    }
    this.dirs.set(path, identityOf(stats));
  }

  /**
   * Checks that `chain` (recorded directories, outermost first) still names the same directories
   * and that `path` names the file `handle` has open.
   */
  async verify(chain: readonly string[], path: string, handle: FileHandle): Promise<void> {
    for (const dir of chain) {
      const stats = await lstat(dir);
      const recorded = this.dirs.get(dir) as Identity;
      if (!stats.isDirectory() || stats.dev !== recorded.dev || stats.ino !== recorded.ino) {
        throw new ExportChangedError(dir);
      }
    }
    const opened = await handle.stat();
    const named = await lstat(path);
    if (named.dev !== opened.dev || named.ino !== opened.ino) throw new ExportChangedError(path);
  }
}

/**
 * Resolves `--out` to `<canonical parent>/<name>` for messages and the first look; the parent must
 * exist (it is not created).
 */
async function targetPath(out: string): Promise<string> {
  const lexical = resolve(out);
  try {
    return join(await realpath(dirname(lexical)), basename(lexical));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new CliError(
        `The parent directory of ${lexical} does not exist; nothing was written.`,
        ExitCode.Usage,
      );
    }
    throw error;
  }
}

/**
 * Accepts a missing `<dir>` (created with a non-recursive `mkdir`, mode 0700) or an empty
 * directory, refusing anything else, including a symbolic link, with exit 2 (FR-123-41), and makes
 * it the working directory. From then on every path is relative to that directory, which works
 * like a directory handle (Node has no `openat`): renaming or replacing `<dir>` or any directory
 * above it no longer changes where the export writes (Codex review rounds 2 and 3). The directory
 * entered must be the one looked at before (same `dev` and `ino`, so a symbolic link swapped in
 * meanwhile is refused), and on POSIX it must be owned by the user and not writable by the group
 * or others, so no other user can rename or replace what the export creates in it.
 */
async function enterTarget(dir: string): Promise<ExportTree> {
  let stats;
  try {
    stats = await lstat(dir);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    try {
      await mkdir(dir, { mode: PRIVATE_DIR_MODE });
    } catch (mkdirError) {
      if (errorCode(mkdirError) === 'EEXIST') {
        throw new CliError(`${dir} appeared while exporting; nothing was written.`, ExitCode.Usage);
      }
      throw mkdirError;
    }
    stats = await lstat(dir);
  }
  if (stats.isSymbolicLink()) {
    throw new CliError(
      `${dir} is a symbolic link, which export does not follow; choose a new or empty directory.`,
      ExitCode.Usage,
    );
  }
  if (!stats.isDirectory()) {
    throw new CliError(
      `${dir} exists and is not a directory; choose a new or empty directory.`,
      ExitCode.Usage,
    );
  }
  process.chdir(dir);
  const here = await lstat(HERE);
  if (here.dev !== stats.dev || here.ino !== stats.ino) throw new ExportChangedError(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && (here.uid !== uid || (here.mode & GROUP_OR_OTHER_WRITE) !== 0)) {
    throw new CliError(
      `${dir} belongs to another user or can be changed by the group or others, who could redirect the export; choose a new directory (the export creates it private) or one only you can write to. Nothing was written.`,
      ExitCode.Usage,
    );
  }
  if ((await readdir(HERE)).length > 0) {
    throw new CliError(
      `${dir} is not empty; choose a new or empty directory. Nothing was written.`,
      ExitCode.Usage,
    );
  }
  return new ExportTree(here);
}

/**
 * Claims the two outputs before any file is written (FR-123-41): `files/` with a non-recursive
 * `mkdir`, then `manifest.json` with exclusive create. `EEXIST` on either is a refusal. `files/`
 * comes first so that undoing a lost claim only ever removes a directory, with `rmdir`, which
 * fails on anything that is not an empty directory: it cannot delete another writer's file.
 */
async function claimOutputs(tree: ExportTree, dir: string): Promise<FileHandle> {
  try {
    await mkdir(FILES_DIR, { mode: PRIVATE_DIR_MODE });
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new CliError(
        `${join(dir, FILES_DIR)} already exists; another export is writing to ${dir}. Nothing was written.`,
        ExitCode.Usage,
      );
    }
    throw error;
  }
  await tree.record(FILES_DIR);
  try {
    return await open(MANIFEST_FILE, 'wx', PRIVATE_FILE_MODE);
  } catch (error) {
    await rmdir(FILES_DIR);
    if (errorCode(error) === 'EEXIST') {
      throw new CliError(
        `${join(dir, MANIFEST_FILE)} already exists; another export is writing to ${dir}. Nothing was written.`,
        ExitCode.Usage,
      );
    }
    throw error;
  }
}

/**
 * Writes kept files below the claimed `files/` directory. Every directory is created one segment
 * at a time with a non-recursive `mkdir` and every file with exclusive create, so nothing that
 * exists is overwritten or followed, and the chain is verified before content is written
 * (`ExportTree`). All entries below `files/` are this export's own, so an `EEXIST` on a name not
 * created yet means two stored names map to one entry (case or Unicode normalisation on the file
 * system, or a file and a directory of the same name).
 */
class FileWriter {
  constructor(private readonly tree: ExportTree) {}

  /** Writes `content` to `segments` below `files/`; false on a name collision. */
  async write(segments: string[], content: string): Promise<boolean> {
    let current = FILES_DIR;
    const chain = [HERE, current];
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      chain.push(current);
      if (this.tree.has(current)) continue;
      try {
        await mkdir(current, { mode: PRIVATE_DIR_MODE });
      } catch (error) {
        if (errorCode(error) === 'EEXIST') return false;
        throw error;
      }
      await this.tree.record(current);
    }
    const target = join(FILES_DIR, ...segments);
    // Validated segments cannot escape; this is the fail-closed check of FR-123-42.
    resolveInside(FILES_DIR, segments.join('/'));
    let handle: FileHandle;
    try {
      handle = await open(target, 'wx', PRIVATE_FILE_MODE);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    }
    try {
      await this.tree.verify(chain, target, handle);
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  }
}

function baselineOf(detail: BenchmarkRunDetail): ExportManifest['baseline'] {
  return detail.baselineArtifactVersion?.version == null
    ? { kind: 'none' }
    : { kind: 'artifact-version', version: detail.baselineArtifactVersion.version };
}

/** Quotes untrusted text for the terminal, so control characters cannot act on it. */
const quoted = (text: string) => JSON.stringify(text);

/** The human-readable summary (FR-123-40, FR-123-42). */
export function exportSummaryText(manifest: ExportManifest, dir: string): string[] {
  const { summary } = manifest;
  const lines = [
    `Exported run ${manifest.runId} to ${dir}`,
    manifest.agent.mock
      ? 'Agent:            Mock agent: not an AI evaluation'
      : `Agent:            ${manifest.agent.adapterId} ${manifest.agent.version ?? '(version unknown)'}`,
    `Agent runs:       ${summary.agentRuns}`,
    `Files written:    ${summary.written}`,
    `Truncated:        ${summary.truncated} (cut at a size limit when captured)`,
    `Not kept:         ${summary.notKept} (binary, deleted, artifact or over the run limit)`,
    `Unsafe paths:     ${summary.unsafePath} (not written)`,
    `Path collisions:  ${summary.pathCollision} (not written)`,
  ];
  for (const run of manifest.agentRuns) {
    for (const file of run.files) {
      if (file.exportReason !== null) {
        lines.push(
          `Not written (${file.exportReason}): ${quoted(run.caseId)} ${run.variant} ${run.repetition}: ${quoted(file.path)}`,
        );
      }
    }
  }
  if (manifest.status === 'running') {
    lines.push('Warning: the run is still running; agent runs that finish later are not exported.');
  }
  lines.push(`Manifest:         ${join(dir, 'manifest.json')}`);
  return lines;
}

/**
 * `directivebench benchmark export <run-id> --out <dir> [--json]` (SPEC-123 §6.4): writes every
 * kept output file of a benchmark run to `<dir>/files/<caseId>/<variant>-<repetition>/<path>` and
 * a `<dir>/manifest.json`. The database is opened read-only and read only through repository
 * functions; stored paths are untrusted (FR-123-42).
 */
export async function benchmarkExportCommand(flags: BenchmarkExportFlags): Promise<number> {
  const { migrationsDir } = resolveAssets();
  const { handle } = openInitializedDatabase(flags.dataDir, migrationsDir);
  try {
    const detail = await getBenchmarkRunDetail(handle.db, flags.runId);
    if (!detail) throw new CliError(`No benchmark run ${flags.runId}`, ExitCode.Usage);
    const dir = await targetPath(flags.out);
    const previousCwd = process.cwd();
    try {
      return await exportInto(dir, detail, handle.db, flags);
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    handle.close();
  }
}

/** Writes the export into `dir`, which becomes the working directory (see `enterTarget`). */
async function exportInto(
  dir: string,
  detail: BenchmarkRunDetail,
  db: Database,
  flags: BenchmarkExportFlags,
): Promise<number> {
  const tree = await enterTarget(dir);
  const manifestHandle = await claimOutputs(tree, dir);
  const writer = new FileWriter(tree);
  const summary: ExportSummary = {
    agentRuns: detail.agentRuns.length,
    files: 0,
    written: 0,
    truncated: 0,
    notKept: 0,
    unsafePath: 0,
    pathCollision: 0,
  };
  let lastWritten: string | null = null;
  try {
    const agentRuns: ExportedAgentRun[] = [];
    for (const run of detail.agentRuns) {
      const runDir = `${run.variant}-${run.repetition}`;
      // A case id is one path segment; an unsafe one makes every file of the run unsafe.
      const caseSafe = isSafeRelativePath(run.caseId) && !run.caseId.includes('/');
      const files: ExportedFile[] = [];
      for (const file of await listAgentRunFiles(db, run.id)) {
        summary.files++;
        const entry: ExportedFile = {
          path: file.path,
          change: file.change,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          kept: file.kept,
          reason: file.reason,
          redactions: file.redactions,
          exportedTo: null,
          exportReason: null,
        };
        files.push(entry);
        if (file.kept === 'none') {
          summary.notKept++;
          continue;
        }
        if (!caseSafe || !isSafeRelativePath(file.path)) {
          entry.exportReason = 'unsafe-path';
          summary.unsafePath++;
          continue;
        }
        const stored = await getAgentRunFile(db, {
          benchmarkRunId: detail.run.id,
          agentRunId: run.id,
          path: file.path,
        });
        const content = stored?.content;
        // Fail closed: a kept file always has content; anything else is a corrupt row.
        if (typeof content !== 'string') {
          throw new Error(`the stored file ${quoted(file.path)} has no content`);
        }
        const segments = [run.caseId, runDir, ...file.path.split('/')];
        if (!(await writer.write(segments, content))) {
          entry.exportReason = 'path-collision';
          summary.pathCollision++;
          continue;
        }
        entry.exportedTo = `files/${segments.join('/')}`;
        lastWritten = entry.exportedTo;
        summary.written++;
        if (file.kept === 'truncated') summary.truncated++;
      }
      agentRuns.push({
        caseId: run.caseId,
        variant: run.variant,
        repetition: run.repetition,
        executionStatus: run.executionStatus,
        outputFilesKept: run.outputFilesKept,
        outputFilesReason: run.outputFilesReason,
        files,
      });
    }
    const manifest: ExportManifest = {
      manifestVersion: EXPORT_MANIFEST_VERSION,
      runId: detail.run.id,
      status: detail.run.status,
      suite: {
        id: detail.suite.slug,
        name: detail.suite.name,
        version: detail.suiteVersion.version,
      },
      candidate: { artifact: detail.artifact.slug, version: detail.artifactVersion.version },
      baseline: baselineOf(detail),
      agent: {
        adapterId: detail.run.agentAdapterId,
        version: detail.run.agentVersion,
        mock: detail.run.agentAdapterId === MOCK_AGENT_ID,
      },
      agentRuns,
      summary,
    };
    await tree.verify([HERE], MANIFEST_FILE, manifestHandle);
    await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            runId: manifest.runId,
            out: dir,
            manifest: join(dir, 'manifest.json'),
            mock: manifest.agent.mock,
            status: manifest.status,
            ...summary,
          },
          null,
          2,
        ),
      );
    } else {
      for (const line of exportSummaryText(manifest, dir)) console.log(line);
    }
    return ExitCode.Ok;
  } catch (error) {
    // Nothing is deleted: the user decides what to do with a partial export (FR-123-43).
    throw new CliError(
      `The export to ${dir} failed after ${summary.written} file(s) (last written: ${lastWritten ?? 'none'}); the directory is left as it is and its manifest.json is incomplete: ${(error as Error).message}`,
      ExitCode.Runtime,
    );
  } finally {
    await manifestHandle.close();
  }
}
