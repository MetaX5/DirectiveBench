import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { canonicalSegment } from './bundle-inspection';
import { importCandidates, IMPORT_TOKEN_MAX_LENGTH } from './import-tokens';
import { errorCode, workspacePinIssue, type WorkspacePin } from './workspace-pin';

/**
 * The most directory entries (files, directories, links and others) one inspection visits
 * (SPEC-118 FR-118-27): above the fixture limit of 5 000 files to leave room for `setup` output.
 */
export const WORKSPACE_SCAN_MAX_FILES = 20_000;

/** The most bytes of regular files one inspection reads (FR-118-27; fixtures: 100 MiB). */
export const WORKSPACE_SCAN_MAX_BYTES = 256 * 1024 * 1024;

/**
 * The most import candidates one inspection resolves against the file system: tokens that are
 * absolute, start with `~` or contain a `..` segment. Each costs at most
 * {@link IMPORT_TOKEN_MAX_LENGTH} characters and one cached `realpath`, so this bounds the scan's
 * work beyond its linear pass; a workspace with more is refused with `workspace-scan-limit`.
 */
export const WORKSPACE_SCAN_MAX_IMPORT_CANDIDATES = 100_000;

export type WorkspaceInspectionCode =
  | 'fixture-contains-claude-config'
  | 'workspace-contains-claude-config'
  | 'workspace-imports-outside'
  | 'workspace-replaced'
  | 'workspace-scan-limit';

export interface WorkspaceFinding {
  code: WorkspaceInspectionCode;
  /** Workspace-relative POSIX path of the entry (`.` for the root). */
  path: string;
  detail: string;
  /** The import token or link text, cut to 200 characters. */
  token?: string;
  /** Where the token or link leads, when known. */
  target?: string;
}

export interface WorkspaceInspectionOptions {
  /** `HOME` of the agent process: `~` in an import resolves here (FR-118-27). */
  homeDir: string;
  /**
   * Code of a Claude Code configuration finding: `fixture-contains-claude-config` for a fixture or
   * overlay at plan time, `workspace-contains-claude-config` (default) right before a spawn.
   */
  claudeConfigCode?: 'fixture-contains-claude-config' | 'workspace-contains-claude-config';
  /**
   * Workspace-relative files the adapter installed (SPEC-203 §4.1). The configuration check —
   * and only it — skips them and their parent directories (FR-118-06); the import scan does not.
   */
  installedPaths?: readonly string[];
}

/** Path segments that make an entry Claude Code configuration, at any depth (FR-118-06). */
const CLAUDE_CONFIG_SEGMENTS = new Set(['.claude', '.claude-plugin']);

/** File names that are Claude Code configuration, at any depth (FR-118-06). */
const CLAUDE_CONFIG_FILES = new Set([
  '.mcp.json',
  'claude.local.md',
  '.worktreeinclude',
  '.claude.json',
]);

/**
 * True when a workspace-relative path is a Claude Code configuration surface (FR-118-06): a
 * segment `.claude` or `.claude-plugin`, or a file named `.mcp.json`, `CLAUDE.local.md`,
 * `.worktreeinclude` or `.claude.json`. Compared case-insensitively and without trailing dots and
 * spaces, so the check also holds on case-insensitive file systems. `CLAUDE.md` and `AGENTS.md`
 * are plain instruction files and are allowed.
 */
export function isClaudeConfigPath(path: string): boolean {
  const segments = path.split('/').map(canonicalSegment);
  return (
    segments.some((segment) => CLAUDE_CONFIG_SEGMENTS.has(segment)) ||
    CLAUDE_CONFIG_FILES.has(segments.at(-1) as string)
  );
}

type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

interface Entry {
  path: string;
  kind: EntryKind;
  stats: Stats;
}

function kindOf(stats: Stats): EntryKind {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function limitFinding(detail: string): WorkspaceFinding {
  return { code: 'workspace-scan-limit', path: '.', detail };
}

/**
 * Lists every entry below `root` without following links, in a deterministic order, counting
 * entries against {@link WORKSPACE_SCAN_MAX_FILES} and regular-file bytes against
 * {@link WORKSPACE_SCAN_MAX_BYTES} before anything is read. A directory that cannot be listed is
 * a configuration finding (it may hide configuration: fail closed).
 */
async function walk(
  root: string,
  configCode: WorkspaceInspectionCode,
): Promise<{ entries: Entry[]; findings: WorkspaceFinding[] } | WorkspaceFinding> {
  const entries: Entry[] = [];
  const findings: WorkspaceFinding[] = [];
  let bytes = 0;
  const pending = [''];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let names: string[];
    try {
      names = (await readdir(join(root, directory))).sort();
    } catch (error) {
      findings.push({
        code: configCode,
        path: directory || '.',
        detail: `the directory cannot be listed (${errorCode(error)}), so it may hide configuration`,
      });
      continue;
    }
    for (const name of names) {
      const path = directory ? `${directory}/${name}` : name;
      if (entries.length + 1 > WORKSPACE_SCAN_MAX_FILES) {
        return limitFinding(`more than ${WORKSPACE_SCAN_MAX_FILES} entries in the workspace`);
      }
      let stats: Stats;
      try {
        stats = await lstat(join(root, path));
      } catch (error) {
        findings.push({
          code: configCode,
          path,
          detail: `the entry cannot be inspected (${errorCode(error)})`,
        });
        continue;
      }
      const kind = kindOf(stats);
      entries.push({ path, kind, stats });
      if (kind === 'directory') pending.push(path);
      if (kind === 'file') {
        bytes += stats.size;
        if (bytes > WORKSPACE_SCAN_MAX_BYTES) {
          return limitFinding(
            `more than ${WORKSPACE_SCAN_MAX_BYTES} bytes of files in the workspace`,
          );
        }
      }
    }
  }
  // Paths are unique, so no two compare equal.
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { entries, findings };
}

/** The installed files and every directory above them, which the configuration check skips. */
function exemptions(installedPaths: readonly string[]): Map<string, EntryKind> {
  const exempt = new Map<string, EntryKind>();
  for (const path of installedPaths) {
    exempt.set(path, 'file');
    for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) {
      exempt.set(parent, 'directory');
    }
  }
  return exempt;
}

function configFindings(
  entries: readonly Entry[],
  code: WorkspaceInspectionCode,
  installedPaths: readonly string[],
): WorkspaceFinding[] {
  const exempt = exemptions(installedPaths);
  return entries
    .filter((entry) => isClaudeConfigPath(entry.path) && exempt.get(entry.path) !== entry.kind)
    .map((entry) => ({
      code,
      path: entry.path,
      detail: 'Claude Code configuration is not allowed in the workspace',
    }));
}

function changed(): Error {
  return Object.assign(new Error('the file changed during the inspection'), { code: 'ECHANGED' });
}

/** Reads a regular file that must still be the entry the walk saw (no swap for a link). */
async function readEntry(root: string, entry: Entry): Promise<Buffer> {
  // O_NONBLOCK keeps a swapped-in FIFO from blocking; O_NOFOLLOW and O_NONBLOCK are undefined on
  // Windows and OR to 0 there. The identity check below covers every platform.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(join(root, entry.path), flags);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== entry.stats.dev ||
      opened.ino !== entry.stats.ino ||
      opened.size !== entry.stats.size
    ) {
      throw changed();
    }
    const buffer = Buffer.alloc(entry.stats.size);
    // One positional read: a regular file below WORKSPACE_SCAN_MAX_BYTES is read whole unless it
    // shrank meanwhile, which is a change like any other.
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw changed();
    return buffer;
  } finally {
    await handle.close();
  }
}

type Resolution =
  | { state: 'inside' | 'missing' }
  | { state: 'outside'; target: string; directory: boolean }
  | { state: 'unknown'; error: string };

class Resolver {
  private readonly cache = new Map<string, Resolution>();

  constructor(private readonly root: string) {}

  async resolve(path: string): Promise<Resolution> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    let result: Resolution;
    try {
      const target = await realpath(path);
      result = isInside(this.root, target)
        ? { state: 'inside' }
        : { state: 'outside', target, directory: (await stat(target)).isDirectory() };
    } catch (error) {
      const code = errorCode(error);
      // These mean no file is there; anything else (EACCES, ELOOP, …) leaves existence unknown.
      result =
        code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG'
          ? { state: 'missing' }
          : { state: 'unknown', error: code };
    }
    this.cache.set(path, result);
    return result;
  }
}

function shown(token: string): string {
  return token.length > 200 ? `${token.slice(0, 200)}…` : token;
}

/**
 * Inspects a workspace — or a fixture, overlay or materialised plan-time workspace — before any
 * `claude` process starts (SPEC-118 FR-118-06/27). One walk, without following links, then:
 *
 * - **Claude Code configuration** (FR-118-06): every entry whose path is
 *   {@link isClaudeConfigPath}, except the adapter's own installed files and their directories.
 * - **Links** (FR-118-27): a symbolic link whose canonical target is outside the workspace or
 *   cannot be resolved, a regular file with more than one hard link, and any other special file.
 * - **Imports** (FR-118-27): every file is read and every `@` token resolved as Claude Code would
 *   — relative to the file, `~` to {@link WorkspaceInspectionOptions.homeDir}, absolute as is —
 *   lexically (from the canonical and from the given workspace path) and physically (`realpath`),
 *   also cut where a Markdown lexer may end the path. An existing file outside the workspace, or a
 *   target whose existence cannot be determined, is a finding; a missing target or an outside
 *   directory (nothing to read) is not. When the workspace
 *   contains a symbolic link, a relative token that climbs above its own directory is a finding
 *   too: through a link the file can be read from a shallower place, where the same `..` leads
 *   out.
 *
 * Limits fail closed: more than {@link WORKSPACE_SCAN_MAX_FILES} entries,
 * {@link WORKSPACE_SCAN_MAX_BYTES} bytes or {@link WORKSPACE_SCAN_MAX_IMPORT_CANDIDATES} resolved
 * candidates, or a shortened token over {@link IMPORT_TOKEN_MAX_LENGTH}, return one
 * `workspace-scan-limit` finding alone. Otherwise the findings are configuration findings first,
 * then link and import findings, in path order; an empty list means the workspace may run.
 */
export async function inspectWorkspace(
  workspace: WorkspacePin,
  options: WorkspaceInspectionOptions,
): Promise<WorkspaceFinding[]> {
  // A workspace a `setup` command replaced (e.g. by a link to a host directory) is never inspected
  // as if it were the run's: the scan would trust the replacement as its root.
  const issue = await workspacePinIssue(workspace);
  if (issue !== null) return [{ code: 'workspace-replaced', path: '.', detail: issue }];
  const root = workspace.canonical;
  // The workspace as used: a process started there may resolve `..` lexically from this path,
  // which differs from the canonical root when an ancestor is a symbolic link.
  const given = workspace.path;
  const home = resolve(options.homeDir);
  const configCode = options.claudeConfigCode ?? 'workspace-contains-claude-config';
  const walked = await walk(root, configCode);
  if (!('entries' in walked)) return [walked];
  const { entries } = walked;
  const findings = [
    ...walked.findings,
    ...configFindings(entries, configCode, options.installedPaths ?? []),
  ];
  const resolver = new Resolver(root);
  const hasLinks = entries.some((entry) => entry.kind === 'symlink');
  const outside = (path: string, detail: string, token?: string, target?: string) => {
    findings.push({
      code: 'workspace-imports-outside',
      path,
      detail,
      ...(token === undefined ? {} : { token: shown(token) }),
      ...(target === undefined ? {} : { target }),
    });
  };
  let resolved = 0;

  for (const entry of entries) {
    const absolute = join(root, entry.path);
    if (entry.kind === 'symlink') {
      const text = await readlink(absolute).catch((error: unknown) => `(${errorCode(error)})`);
      const resolution = await resolver.resolve(absolute);
      if (resolution.state === 'outside') {
        outside(entry.path, 'a symbolic link leads outside the workspace', text, resolution.target);
      } else if (resolution.state !== 'inside') {
        outside(entry.path, 'a symbolic link whose target cannot be resolved', text);
      }
      continue;
    }
    if (entry.kind === 'other') {
      outside(
        entry.path,
        'not a regular file, directory or symbolic link, so it cannot be checked',
      );
      continue;
    }
    if (entry.kind !== 'file') continue;
    if (entry.stats.nlink > 1) {
      outside(entry.path, 'a regular file with more than one hard link may be a host file');
      continue;
    }
    let content: Buffer;
    try {
      content = await readEntry(root, entry);
    } catch (error) {
      outside(
        entry.path,
        `the file cannot be read (${errorCode(error)}), so its imports cannot be checked`,
      );
      continue;
    }
    if (!content.includes(0x40)) continue;
    const directory = dirname(absolute);
    const reported = new Set<string>();
    for (const candidate of importCandidates(content.toString('utf8'))) {
      if (candidate.kind === 'too-long') {
        return [
          limitFinding(
            `an import token in ${entry.path} is longer than ${IMPORT_TOKEN_MAX_LENGTH} characters and contains . or .. segments, repeated / or escaped spaces`,
          ),
        ];
      }
      resolved += 1;
      if (resolved > WORKSPACE_SCAN_MAX_IMPORT_CANDIDATES) {
        return [
          limitFinding(
            `more than ${WORKSPACE_SCAN_MAX_IMPORT_CANDIDATES} import tokens to resolve in the workspace`,
          ),
        ];
      }
      const { kind, token } = candidate;
      if (reported.has(token)) continue;
      const rest = token.slice(1);
      const physical =
        kind === 'absolute' ? token : kind === 'home' ? `${home}${rest}` : `${directory}/${token}`;
      const lexical = resolve(physical);
      const givenLexical =
        kind === 'relative' ? resolve(given, dirname(entry.path), token) : lexical;
      if (kind === 'relative' && hasLinks && posix.normalize(token).startsWith('..')) {
        reported.add(token);
        outside(
          entry.path,
          'an import climbs above its own directory in a workspace with symbolic links, through which the file can be read from another place',
          token,
        );
        continue;
      }
      for (const path of new Set([lexical, givenLexical, physical])) {
        const resolution = await resolver.resolve(path);
        // An import of a directory discloses nothing (Claude Code cannot read it as a file), so
        // `@/lib` in ordinary code passes; a link to an outside directory is still refused above.
        if (resolution.state === 'outside' && !resolution.directory) {
          reported.add(token);
          outside(
            entry.path,
            'an import names an existing file outside the workspace',
            token,
            resolution.target,
          );
          break;
        }
        if (resolution.state === 'unknown') {
          reported.add(token);
          outside(
            entry.path,
            `an import names a path whose existence cannot be determined (${resolution.error})`,
            token,
            path,
          );
          break;
        }
      }
    }
  }
  return findings;
}
