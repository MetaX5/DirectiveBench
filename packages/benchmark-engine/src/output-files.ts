import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentAdapter, WorkspacePin } from '@directivebench/agent-adapters';
import {
  findSecretRanges,
  mergeTextRanges,
  REDACTION_MARKER,
  replaceTextRanges,
  type TextEnd,
  type TextRange,
} from '@directivebench/core';
import { buildManifest, diffManifests, type FileChange, type ManifestFile } from './files';

/** Content kept per output file, in bytes (SPEC-123 FR-123-05; UI copy "1 MB"). */
export const OUTPUT_FILE_MAX_BYTES = 1_048_576;
/** Content kept per agent run, in bytes (SPEC-123 FR-123-05; UI copy "10 MB"). */
export const OUTPUT_RUN_MAX_BYTES = 10_485_760;
/**
 * How far past the budget a file is read, so a pattern secret that starts at or before the cut has
 * its shortest recognisable prefix inside the read window (SPEC-123 FR-123-06). At least the
 * longest of `SECRET_PATTERN_MIN_LENGTHS` (a unit test checks it).
 */
export const OUTPUT_REDACTION_MARGIN_BYTES = 4096;
/**
 * A private-key marker start (`-----BEGIN ` or `-----END `) whose `PRIVATE KEY-----` does not
 * follow within this many bytes counts as an `END` marker ending there (SPEC-123 FR-123-07), so
 * the whole-file scan holds at most this much of a pending marker.
 */
export const KEY_MARKER_MAX_BYTES = 256;
/** Bytes read per call when streaming the part of a file beyond its read window. */
const READ_CHUNK_BYTES = 65_536;

export type OutputFileKept = 'full' | 'truncated' | 'none';
export type OutputFileReason = 'file-limit' | 'run-limit' | 'binary' | 'deleted' | 'artifact-path';

/** One changed file of an agent run as captured (SPEC-123 §8.2). */
export interface CapturedFile {
  path: string;
  change: FileChange['change'];
  /** Original size; null for a deleted file. */
  sizeBytes: number | null;
  /** sha256 of the original bytes; null for a deleted file. */
  sha256: string | null;
  kept: OutputFileKept;
  /** Null when `kept` is `full`. */
  reason: OutputFileReason | null;
  /** Redacted text; null when nothing is kept. */
  content: string | null;
  /** UTF-8 bytes of `content`. */
  storedBytes: number;
  /** Merged secret ranges replaced in `content`. */
  redactions: number;
}

/**
 * The content of one agent run's capture. It travels only as the second argument of
 * `onAgentRun` and is never stored in an `AgentRunRecord` (SPEC-123 FR-123-10).
 */
export interface OutputFilesCapture {
  files: CapturedFile[];
}

/** What an `AgentRunRecord` keeps of the capture: metadata only (SPEC-123 §8.2). */
export interface OutputFilesSummary {
  status: 'kept' | 'not-kept' | 'not-captured';
  /** Why the files were not kept or not captured; null when kept. */
  reason: string | null;
  files: number;
  truncated: number;
  notKept: number;
  storedBytes: number;
}

/** No consumer (`onAgentRun`) could keep the content, so nothing was captured (FR-123-10). */
export const NOT_CAPTURED: OutputFilesSummary = {
  status: 'not-captured',
  reason: 'no-consumer',
  files: 0,
  truncated: 0,
  notKept: 0,
  storedBytes: 0,
};

/** The summary of an agent run whose files were not kept, with the reason. */
export function notKeptOutput(reason: string): OutputFilesSummary {
  return { ...NOT_CAPTURED, status: 'not-kept', reason };
}

export function summarizeCapture(capture: OutputFilesCapture): OutputFilesSummary {
  return {
    status: 'kept',
    reason: null,
    files: capture.files.length,
    truncated: capture.files.filter((f) => f.kept === 'truncated').length,
    notKept: capture.files.filter((f) => f.kept === 'none').length,
    storedBytes: capture.files.reduce((sum, f) => sum + f.storedBytes, 0),
  };
}

/** A capture that cannot be trusted or completed; its message becomes the stored reason. */
export class OutputCaptureError extends Error {
  override name = 'OutputCaptureError';
}

type SecretFinder = Pick<AgentAdapter, 'findOutputSecrets'>;

export interface CaptureInput {
  workspace: WorkspacePin;
  /** The manifest taken after installation and before the agent ran. */
  before: readonly ManifestFile[];
  /**
   * The measurement manifest of a `completed` run and its change list, reused as they are
   * (FR-123-02); null for an `agent-error` or `timeout` run, whose capture builds its own.
   */
  measured: { after: readonly ManifestFile[]; changes: readonly FileChange[] } | null;
  /** Workspace-relative paths the artifact installation wrote; their files are not kept (A7). */
  installedPaths: readonly string[];
  adapter: SecretFinder;
}

export type CaptureOutcome =
  { ok: true; capture: OutputFilesCapture; changes: FileChange[] } | { ok: false; reason: string };

/**
 * Captures the files an agent run added or modified, bounded, redacted and checked against the
 * manifest (SPEC-123 §6.1). Never throws: any failure is returned with a redacted reason, so it
 * cannot change the measurement (FR-123-09).
 */
export async function captureOutputFiles(input: CaptureInput): Promise<CaptureOutcome> {
  try {
    const after = input.measured?.after ?? (await buildManifest(input.workspace.path));
    const changes = input.measured
      ? [...input.measured.changes]
      : diffManifests(input.before, after);
    const entries = new Map(after.map((file) => [file.path, file]));
    const files: CapturedFile[] = [];
    const reading: { change: FileChange; entry: ManifestFile }[] = [];
    for (const change of changes) {
      // A deleted file has no entry after the run.
      const entry = entries.get(change.path) ?? null;
      // Any path of the installed artifact, deleted ones included, is listed as such (A7).
      if (isArtifactPath(change.path, input.installedPaths)) {
        files.push(metadataOnly(change, entry, 'artifact-path'));
      } else if (entry === null) {
        files.push(metadataOnly(change, null, 'deleted'));
      } else {
        reading.push({ change, entry });
      }
    }
    // Ascending original size, then path (A4): many small files cannot be starved by a large one.
    // The change list is in path order (`diffManifests`) and the sort is stable.
    reading.sort((a, b) => a.entry.size - b.entry.size);
    let runLeft = OUTPUT_RUN_MAX_BYTES;
    for (const { change, entry } of reading) {
      const file = await captureFile(input, change, entry, runLeft).catch((error: unknown) => {
        if (error instanceof OutputCaptureError) throw error;
        // A file system error names the absolute path; the reason names the workspace path only.
        throw new OutputCaptureError(
          `${entry.path} could not be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
        );
      });
      runLeft -= file.storedBytes;
      files.push(file);
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { ok: true, capture: { files }, changes };
  } catch (error) {
    return { ok: false, reason: captureFailureReason(error, input.adapter) };
  }
}

function metadataOnly(
  change: FileChange,
  entry: ManifestFile | null,
  reason: OutputFileReason,
): CapturedFile {
  return {
    path: change.path,
    change: change.change,
    sizeBytes: entry?.size ?? null,
    sha256: entry?.sha256 ?? null,
    kept: 'none',
    reason,
    content: null,
    storedBytes: 0,
    redactions: 0,
  };
}

/** A path equal to or below one the artifact installation wrote (FR-123-08, A7). */
function isArtifactPath(path: string, installedPaths: readonly string[]): boolean {
  return installedPaths.some((installed) => path === installed || path.startsWith(`${installed}/`));
}

/**
 * The redacted message of a failed capture (FR-123-09), with the core rules and the adapter's
 * ranges; a message the adapter cannot redact validly is replaced by a generic one (fail closed).
 */
function captureFailureReason(error: unknown, adapter: SecretFinder): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const textEnd = { textEnd: 'file-end' } as const;
    const ranges = [
      ...findSecretRanges(message, [], textEnd),
      ...checkedRanges(adapter.findOutputSecrets(message, textEnd), message),
    ];
    return replaceTextRanges(message, mergeTextRanges(ranges));
  } catch {
    return 'the output files could not be captured';
  }
}

/** The adapter's ranges after checking each one (FR-123-07); an invalid range fails the capture. */
function checkedRanges(ranges: readonly TextRange[], text: string): readonly TextRange[] {
  for (const range of ranges) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.start >= range.end ||
      range.end > text.length
    ) {
      throw new OutputCaptureError('the agent adapter returned an invalid secret range');
    }
  }
  return ranges;
}

/** File IDs some file systems report when they have none: identity cannot be proved. */
const UNKNOWN_FILE_IDS: readonly bigint[] = [0n, 0xffff_ffff_ffff_ffffn];

function isSameRegularFile(opened: BigIntStats, path: BigIntStats): boolean {
  return (
    opened.isFile() && !path.isSymbolicLink() && opened.ino === path.ino && opened.dev === path.dev
  );
}

/**
 * Checks that `path`'s directory still lies inside the pinned workspace: the workspace path is
 * the pinned directory (same device and inode, not a link), every directory component below it
 * is a real directory (`lstat`, so a link in any component is refused) and the directory resolves
 * to its place below the pinned canonical path.
 */
async function assertDirectoryInsidePin(workspace: WorkspacePin, path: string): Promise<boolean> {
  const root = await lstat(workspace.path);
  if (!root.isDirectory() || root.dev !== workspace.dev || root.ino !== workspace.ino) return false;
  let dir = workspace.path;
  for (const segment of dirname(path).split('/')) {
    if (segment === '.') continue;
    dir = join(dir, segment);
    if (!(await lstat(dir)).isDirectory()) return false;
  }
  return (await realpath(dir)) === join(workspace.canonical, dirname(path));
}

/**
 * Opens a changed file through the pinned workspace without following a link (FR-123-04): its
 * directory must lie inside the pinned workspace ({@link assertDirectoryInsidePin}) before and
 * after the open, the open refuses a link in the last component where the platform can
 * (`O_NOFOLLOW`), and the handle and the path must be the same regular file with a usable identity
 * (lesson 2026-10-19). The agent's process tree has exited, so nothing should change the workspace
 * now; a swap that still slipped between these checks is caught by the size and sha256 comparison
 * with the manifest.
 */
async function openChangedFile(workspace: WorkspacePin, path: string): Promise<FileHandle> {
  const abs = join(workspace.path, path);
  const unsafe = () => new OutputCaptureError(`${path} is not the file the manifest listed`);
  if (!(await assertDirectoryInsidePin(workspace, path))) throw unsafe();
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(abs, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      UNKNOWN_FILE_IDS.includes(opened.ino) ||
      !isSameRegularFile(opened, await lstat(abs, { bigint: true })) ||
      !(await assertDirectoryInsidePin(workspace, path))
    ) {
      throw unsafe();
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function captureFile(
  input: CaptureInput,
  change: FileChange,
  entry: ManifestFile,
  runLeft: number,
): Promise<CapturedFile> {
  const budget = Math.min(OUTPUT_FILE_MAX_BYTES, runLeft);
  if (budget <= 0) return metadataOnly(change, entry, 'run-limit');
  const limitReason: OutputFileReason =
    runLeft < OUTPUT_FILE_MAX_BYTES ? 'run-limit' : 'file-limit';
  const { bytes, wholeFile, keyFragments } = await readWindow(
    input.workspace,
    entry,
    budget + OUTPUT_REDACTION_MARGIN_BYTES,
  );
  if (bytes.includes(0) || !isUtf8(bytes)) return metadataOnly(change, entry, 'binary');
  const text = bytes.toString('utf8');
  const textEnd: TextEnd = wholeFile ? 'file-end' : 'cut';
  const merged = mergeTextRanges([
    ...findSecretRanges(text, [], { textEnd }),
    ...checkedRanges(input.adapter.findOutputSecrets(text, { textEnd }), text),
    // Key fragments as the whole-file scan sees them: a fragment whose END lies beyond the
    // window, or behind an overlong marker, is invisible to the window alone (FR-123-07).
    ...utf16Ranges(bytes, keyFragments),
  ]);
  const cut = placeCut(text, merged, budget);
  const full = wholeFile && cut.end === text.length;
  return {
    path: change.path,
    change: change.change,
    sizeBytes: entry.size,
    sha256: entry.sha256,
    kept: full ? 'full' : 'truncated',
    reason: full ? null : limitReason,
    content: cut.content,
    storedBytes: Buffer.byteLength(cut.content),
    redactions: cut.redactions,
  };
}

/**
 * Reads at most `windowBytes` of a changed file into memory and streams the rest only into the
 * sha256 hash and the key-marker scan, which see every byte in file order; then checks size and
 * hash against the manifest entry (FR-123-04). Any mismatch or read error fails the capture.
 */
async function readWindow(
  workspace: WorkspacePin,
  entry: ManifestFile,
  windowBytes: number,
): Promise<{ bytes: Buffer; wholeFile: boolean; keyFragments: TextRange[] }> {
  const changed = () => new OutputCaptureError(`${entry.path} changed after the agent stopped`);
  const handle = await openChangedFile(workspace, entry.path);
  try {
    if ((await handle.stat()).size !== entry.size) throw changed();
    const hash = createHash('sha256');
    const window = Buffer.alloc(Math.min(entry.size, windowBytes));
    let total = await readFully(handle, window, 0);
    if (total !== window.length) throw changed();
    // A cut read may end inside a character; the text, and so the window end, stops before it.
    const wholeFile = window.length === entry.size;
    const bytes = wholeFile ? window : trimIncompleteUtf8(window);
    const scan = new KeyMarkerScan(bytes.length);
    hash.update(window);
    scan.push(window);
    // Only the manifested bytes are read; a file that grew since is refused after a one-byte
    // probe, so a writer cannot make the capture read without bound (Codex review round 1).
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    while (total < entry.size) {
      const want = Math.min(chunk.length, entry.size - total);
      const { bytesRead } = await handle.read(chunk, 0, want, total);
      if (bytesRead === 0) throw changed();
      const part = chunk.subarray(0, bytesRead);
      hash.update(part);
      scan.push(part);
      total += bytesRead;
    }
    if ((await handle.read(chunk, 0, 1, total)).bytesRead !== 0) throw changed();
    const keyFragments = scan.end();
    if (hash.digest('hex') !== entry.sha256) throw changed();
    return { bytes, wholeFile, keyFragments };
  } finally {
    await handle.close();
  }
}

/** Fills `buffer` from `position` until it is full or the file ends; returns the bytes read. */
async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

/**
 * `bytes` without an incomplete UTF-8 character at its end (a read cut inside one). An invalid
 * sequence is left for `isUtf8` to refuse.
 */
export function trimIncompleteUtf8(bytes: Buffer): Buffer {
  let start = bytes.length - 1;
  // Up to three continuation bytes (10xxxxxx) precede the end of a four-byte character.
  while (start >= 0 && start >= bytes.length - 3 && ((bytes[start] as number) & 0xc0) === 0x80) {
    start -= 1;
  }
  if (start < 0) return bytes;
  const lead = bytes[start] as number;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - start < length ? bytes.subarray(0, start) : bytes;
}

/**
 * Byte ranges of valid UTF-8 `bytes` converted to UTF-16 offsets of its decoded text, in one pass.
 * `ranges` must be sorted by start, non-overlapping, and lie on character boundaries.
 */
export function utf16Ranges(bytes: Buffer, ranges: readonly TextRange[]): TextRange[] {
  let byte = 0;
  let unit = 0;
  const offset = (target: number): number => {
    for (; byte < target; byte += 1) {
      const value = bytes[byte] as number;
      // Every byte that starts a character adds one unit, a four-byte one (a surrogate pair) two.
      if ((value & 0xc0) !== 0x80) unit += value >= 0xf0 ? 2 : 1;
    }
    return unit;
  };
  return ranges.map((range) => ({ start: offset(range.start), end: offset(range.end) }));
}

const MARKER_BYTES = Buffer.byteLength(REDACTION_MARKER);

/** UTF-16 units and UTF-8 bytes of the character at `i`, not reading past `end`. */
function charAt(text: string, i: number, end: number): [units: number, bytes: number] {
  const code = text.charCodeAt(i);
  if (code < 0x80) return [1, 1];
  if (code < 0x800) return [1, 2];
  if (code >= 0xd800 && code <= 0xdbff && i + 1 < end) {
    const next = text.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return [2, 4];
  }
  return [1, 3];
}

/**
 * Places the cut (FR-123-06): the largest prefix of `text` whose original bytes and redacted bytes
 * both fit `budget`, never inside a secret range (a range that does not fit ends the prefix at its
 * start). Returns the redacted prefix, where it ends in `text`, and the ranges it replaced.
 */
export function placeCut(
  text: string,
  ranges: readonly TextRange[],
  budget: number,
): { content: string; end: number; redactions: number } {
  let original = 0;
  let stored = 0;
  let i = 0;
  let content = '';
  let redactions = 0;
  for (const range of [...ranges, { start: text.length, end: text.length }]) {
    // The plain text before the range, character by character once it no longer fits whole.
    const plainBytes = Buffer.byteLength(text.slice(i, range.start));
    if (original + plainBytes <= budget && stored + plainBytes <= budget) {
      original += plainBytes;
      stored += plainBytes;
      content += text.slice(i, range.start);
      i = range.start;
    } else {
      let end = i;
      while (end < range.start) {
        const [units, bytes] = charAt(text, end, range.start);
        if (original + bytes > budget || stored + bytes > budget) break;
        original += bytes;
        stored += bytes;
        end += units;
      }
      return { content: content + text.slice(i, end), end, redactions };
    }
    if (range.end === range.start) break;
    const secretBytes = Buffer.byteLength(text.slice(range.start, range.end));
    if (original + secretBytes > budget || stored + MARKER_BYTES > budget) {
      return { content, end: i, redactions };
    }
    original += secretBytes;
    stored += MARKER_BYTES;
    content += REDACTION_MARKER;
    redactions += 1;
    i = range.end;
  }
  return { content, end: i, redactions };
}

type MarkerKind = 'BEGIN' | 'END';

const BEGIN_START = '-----BEGIN ';
const END_START = '-----END ';
const KEY_TAIL = 'PRIVATE KEY';
const DASHES = '-----';

function isMarkerChar(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || code === 0x20;
}

/**
 * One stateful pass over a whole file, in order, finding private-key markers
 * (`-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----`) across chunk boundaries (FR-123-04/07). A marker
 * start whose end is not decided within {@link KEY_MARKER_MAX_BYTES} bytes (an overlong middle,
 * or the file ends first) counts as an `END` marker ending there, so the pending text it holds is
 * bounded. Bytes are scanned as latin1 text, one character per byte, so offsets are byte offsets.
 *
 * It records the markers up to the first one that ends after `windowEnd`, which is all the
 * private-key rule needs to classify the window's text.
 */
export class KeyMarkerScan {
  private pending = '';
  /** Byte offset of `pending[0]` in the file. */
  private pendingAt = 0;
  private readonly markers: { kind: MarkerKind; start: number; end: number }[] = [];

  constructor(private readonly windowEnd: number) {}

  push(bytes: Buffer): void {
    if (!this.decided()) this.scan(this.pending + bytes.toString('latin1'), false);
  }

  /**
   * Ends the scan and returns the private-key fragments of the window `[0, windowEnd)` in bytes,
   * by the rule of trace redaction applied to the whole file: the text after a `BEGIN` marker up
   * to the next marker (or the end of the file) and the text before an `END` marker that does not
   * follow a `BEGIN`, clipped to the window.
   */
  end(): TextRange[] {
    if (!this.decided()) this.scan(this.pending, true);
    const fragments: TextRange[] = [];
    let from = 0;
    let previous: MarkerKind | null = null;
    for (const marker of this.markers) {
      if (previous === 'BEGIN' || marker.kind === 'END') {
        fragments.push({ start: from, end: Math.min(marker.start, this.windowEnd) });
      }
      from = marker.end;
      previous = marker.kind;
    }
    if (previous === 'BEGIN') fragments.push({ start: from, end: this.windowEnd });
    return fragments.filter((range) => range.start < range.end);
  }

  /** A marker ending after the window is recorded: later markers cannot change the window. */
  private decided(): boolean {
    return (this.markers.at(-1)?.end ?? 0) > this.windowEnd;
  }

  private scan(text: string, final: boolean): void {
    const base = this.pendingAt;
    let from = 0;
    for (;;) {
      const start = text.indexOf(DASHES, from);
      if (start === -1) {
        // Keep a tail that could still begin a marker start (`-----BEGIN` lacks one byte).
        return this.keep(text, base, Math.max(from, text.length - (BEGIN_START.length - 1)));
      }
      const prefix = text.startsWith(BEGIN_START, start)
        ? BEGIN_START
        : text.startsWith(END_START, start)
          ? END_START
          : null;
      if (prefix === null) {
        if (!final && text.length - start < BEGIN_START.length) return this.keep(text, base, start);
        from = start + 1;
        continue;
      }
      const marker = this.classify(text, start, prefix, final);
      if (marker === 'more') return this.keep(text, base, start);
      if (marker === null) {
        from = start + 1;
        continue;
      }
      this.markers.push({ kind: marker.kind, start: base + start, end: base + marker.end });
      if (this.decided()) return;
      from = marker.end;
    }
  }

  /**
   * The marker starting at `start`, null when the text there cannot be one, or `more` when the
   * next chunk is needed to decide. Text the regex could never match (the `[A-Z ]` run ends
   * without `PRIVATE KEY-----`, as in `-----BEGIN PUBLIC KEY-----`) is no marker, exactly as for
   * trace redaction; only a start still undecided after {@link KEY_MARKER_MAX_BYTES} bytes, or at
   * the end of the file, counts as an `END` marker (fail closed).
   */
  private classify(
    text: string,
    start: number,
    prefix: string,
    final: boolean,
  ): { kind: MarkerKind; end: number } | null | 'more' {
    const kind: MarkerKind = prefix === BEGIN_START ? 'BEGIN' : 'END';
    const limit = start + KEY_MARKER_MAX_BYTES;
    let run = start + prefix.length;
    while (run < text.length && run < limit && isMarkerChar(text.charCodeAt(run))) run += 1;
    if (run === limit) return { kind: 'END', end: limit };
    if (run === text.length) return final ? { kind: 'END', end: text.length } : 'more';
    // The run of [A-Z ] ended: only `PRIVATE KEY` at its end followed by five dashes is a marker.
    if (
      run - KEY_TAIL.length < start + prefix.length ||
      !text.startsWith(KEY_TAIL, run - KEY_TAIL.length)
    ) {
      return null;
    }
    if (run + DASHES.length > limit) return { kind: 'END', end: limit };
    if (text.length < run + DASHES.length && !final) return 'more';
    return text.startsWith(DASHES, run) ? { kind, end: run + DASHES.length } : null;
  }

  private keep(text: string, base: number, from: number): void {
    this.pending = text.slice(from);
    this.pendingAt = base + from;
  }
}
