// Display logic for the files an agent run wrote (SPEC-123 §6.2, A14). The shapes mirror the
// proposed `agent_run_files` columns (SPEC-123 §8.1); once Phase 1 adds the table, the
// repository type replaces OutputFile. Pure functions, so the components stay presentational.

export type FileChange = 'added' | 'modified' | 'deleted';
export type FileKept = 'full' | 'truncated' | 'none';
export type FileKeptReason = 'file-limit' | 'run-limit' | 'binary' | 'deleted' | 'artifact-path';

export interface OutputFile {
  path: string;
  change: FileChange;
  /** Original size in bytes; null for a deleted file. */
  sizeBytes: number | null;
  kept: FileKept;
  reason: FileKeptReason | null;
  /** Redacted UTF-8 text; null when nothing was kept. */
  content: string | null;
  /** Secrets the redaction replaced in `content`. */
  redactions: number;
}

/** Badge variants this mapping uses; a subset of the Badge component's variants. */
export type FileBadgeVariant = 'outline' | 'warning' | 'muted' | 'info';

export interface FileBadge {
  label: string;
  variant: FileBadgeVariant;
}

// UI copy for the limits of SPEC-123 A3 (OUTPUT_FILE_MAX_BYTES, OUTPUT_RUN_MAX_BYTES).
const FILE_LIMIT_LABEL = '1 MB';
const RUN_LIMIT_LABEL = '10 MB';

const changeLabels: Record<FileChange, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

const notKeptLabels: Record<FileKeptReason, string> = {
  binary: 'Binary, not kept',
  'artifact-path': 'Artifact file',
  'run-limit': 'Not kept',
  'file-limit': 'Not kept',
  deleted: 'Not kept',
};

/**
 * The badges of one file in a list: its change (a property, so `outline`), then what was kept
 * when it was not the whole file, then the redaction count. A deleted file needs no second
 * badge: "Deleted" already says why nothing is shown.
 */
export function fileBadges(
  file: Pick<OutputFile, 'change' | 'kept' | 'reason' | 'redactions'>,
): FileBadge[] {
  const badges: FileBadge[] = [{ label: changeLabels[file.change], variant: 'outline' }];
  if (file.kept === 'truncated') badges.push({ label: 'Truncated', variant: 'warning' });
  if (file.kept === 'none' && file.change !== 'deleted') {
    badges.push({ label: notKeptLabels[file.reason ?? 'run-limit'], variant: 'muted' });
  }
  if (file.redactions > 0) badges.push({ label: `${file.redactions} redacted`, variant: 'info' });
  return badges;
}

/** The badge of a path present in only one of two compared agent runs. */
export function onlyInBadge(side: string): FileBadge {
  return { label: `Only ${side}`, variant: 'outline' };
}

const integer = new Intl.NumberFormat('en-US');

/** "1 byte", "2,184 bytes": exact, for limits and notices. */
export function formatBytes(bytes: number): string {
  return `${integer.format(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

const KIB = 1024;
const MIB = 1024 * 1024;

/** A short size for lists: bytes below 1 KB, then KB and MB with one decimal (binary units). */
export function formatSize(bytes: number): string {
  if (bytes < KIB) return formatBytes(bytes);
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}

/**
 * The sentences shown above a file (SPEC-123 FR-123-21): why it is cut or not shown, how many
 * secrets were redacted and whether carriage returns were changed for display.
 */
export function fileNotices(file: OutputFile): string[] {
  const notices: string[] = [];
  if (file.change === 'deleted') notices.push('Deleted by the agent.');
  else if (file.kept === 'truncated') {
    notices.push(
      file.reason === 'run-limit'
        ? `Truncated: the ${RUN_LIMIT_LABEL} limit for this agent run was reached.`
        : `Truncated at ${FILE_LIMIT_LABEL}: the file has ${formatBytes(file.sizeBytes ?? 0)}.`,
    );
  } else if (file.kept === 'none') {
    notices.push(
      file.reason === 'binary'
        ? 'Binary file, not kept.'
        : file.reason === 'artifact-path'
          ? 'Artifact file, not kept.'
          : `Not kept: the ${RUN_LIMIT_LABEL} limit for this agent run was reached.`,
    );
  } else if (file.content === '') notices.push('The file is empty.');
  if (file.redactions > 0) {
    notices.push(`${file.redactions} ${file.redactions === 1 ? 'secret' : 'secrets'} redacted.`);
  }
  if (file.content?.includes('\r')) notices.push('Shown with LF line endings.');
  return notices;
}

/**
 * Splits text into display lines. CR LF and lone CR become line breaks (the DOM cannot show a
 * CR, lesson 2026-10-20), and a final line break does not add an empty last line.
 */
export function displayLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
