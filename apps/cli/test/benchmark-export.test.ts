import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createBenchmarkRun,
  getBenchmarkRunDetail,
  insertAgentRun,
  openDatabase,
  type AgentRunFileInput,
  type AgentRunInput,
} from '@directivebench/database';
import {
  benchmarkExportCommand,
  isSafeRelativePath,
  type ExportManifest,
} from '../src/benchmark-export';
import { demoCommand } from '../src/commands';
import { CliError, ExitCode } from '../src/runtime';

// Every `mkdir`, `open` and `lstat` of the export passes through `fsHooks.before`, and every
// `lstat` result through `fsHooks.afterLstat`, so a test can make one fail or win a race at an
// exact point (lesson 2026-10-21: simulate errors the code cannot repair).
const fsHooks = vi.hoisted(() => ({
  before: null as null | ((op: 'mkdir' | 'open' | 'lstat', path: string) => void),
  afterLstat: null as null | ((path: string, stats: Stats) => void),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    mkdir: ((path: string, ...rest: never[]) => {
      fsHooks.before?.('mkdir', String(path));
      return actual.mkdir(path, ...rest);
    }) as typeof actual.mkdir,
    open: ((path: string, ...rest: never[]) => {
      fsHooks.before?.('open', String(path));
      return actual.open(path, ...rest);
    }) as typeof actual.open,
    lstat: (async (path: string, ...rest: never[]) => {
      fsHooks.before?.('lstat', String(path));
      const stats = await actual.lstat(path, ...rest);
      fsHooks.afterLstat?.(String(path), stats);
      return stats;
    }) as typeof actual.lstat,
  };
});

const fsError = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

/** A demo run (mock agent) plus hand-made runs with hostile stored rows, in one data directory. */
let dataDir: string;
let demoRunId: string;
let hostileRunId: string;
let corruptRunId: string;
let scratch: string;

const file = (path: string, over: Partial<AgentRunFileInput> = {}): AgentRunFileInput => ({
  path,
  change: 'added',
  sizeBytes: 5,
  sha256: 'a'.repeat(64),
  kept: 'full',
  reason: null,
  content: `content of ${path}`,
  storedBytes: 5,
  redactions: 0,
  ...over,
});

const UNSAFE_PATHS = [
  '../escape.txt',
  '/abs.txt',
  'a\\b.txt',
  'C:drive.txt',
  'a//b.txt',
  './dot.txt',
  'a/./b.txt',
  'trail/',
  'nul\0.txt',
];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'db-cli-export-data-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await demoCommand({ dataDir })).toBe(ExitCode.Ok);
  const runLine = log.mock.calls.map((call) => String(call[0])).find((l) => l.includes('Run id:'));
  log.mockRestore();
  demoRunId = /Run id: +(\S+)/.exec(String(runLine))?.[1] as string;

  const handle = openDatabase(join(dataDir, 'directivebench.db'));
  try {
    const demo = await getBenchmarkRunDetail(handle.db, demoRunId);
    const base = {
      jobId: null,
      suiteVersionId: demo!.suiteVersion.id,
      artifactVersionId: demo!.artifactVersion.id,
      agentVersion: null,
      model: null,
      environment: {},
    };
    hostileRunId = await createBenchmarkRun(handle.db, {
      ...base,
      baselineArtifactVersionId: demo!.artifactVersion.id,
      agentAdapterId: 'claude-code',
    });
    const agentRun = (over: Partial<AgentRunInput>): AgentRunInput => ({
      benchmarkRunId: hostileRunId,
      caseId: 'case-a',
      variant: 'candidate',
      repetition: 1,
      fixtureVersionId: demo!.agentRuns[0]!.fixtureVersionId,
      executionStatus: 'completed',
      score: 1,
      passed: true,
      durationMs: 1,
      changedFiles: [],
      trace: [],
      usage: null,
      error: null,
      assertions: [],
      outputFilesKept: true,
      outputFilesReason: null,
      outputFiles: [],
      ...over,
    });
    await insertAgentRun(
      handle,
      agentRun({
        outputFiles: [
          file('ok.txt'),
          file('dir/nested.js', { kept: 'truncated', reason: 'file-limit', redactions: 2 }),
          file('bin.dat', { kept: 'none', reason: 'binary', content: null, storedBytes: 0 }),
          file('gone.txt', {
            change: 'deleted',
            kept: 'none',
            reason: 'deleted',
            sizeBytes: null,
            sha256: null,
            content: null,
            storedBytes: 0,
          }),
          // `foo` is written as a file, so `foo/bar.txt` cannot get a directory `foo`.
          file('foo'),
          file('foo/bar.txt'),
          ...UNSAFE_PATHS.map((path) => file(path)),
        ],
      }),
    );
    // The same case, variant and repetition again: its `ok.txt` collides with the first one.
    await insertAgentRun(handle, agentRun({ outputFiles: [file('ok.txt'), file('other.txt')] }));
    // Unsafe case ids make every kept file of the agent run unsafe.
    await insertAgentRun(handle, agentRun({ caseId: '../evil', outputFiles: [file('x.txt')] }));
    await insertAgentRun(handle, agentRun({ caseId: 'a/b', outputFiles: [file('y.txt')] }));
    await insertAgentRun(
      handle,
      agentRun({
        variant: 'baseline',
        executionStatus: 'timeout',
        outputFilesKept: false,
        outputFilesReason: 'the agent did not stop after its timeout',
      }),
    );

    corruptRunId = await createBenchmarkRun(handle.db, {
      ...base,
      baselineArtifactVersionId: null,
      agentAdapterId: 'claude-code',
      agentVersion: '2.0.0',
    });
    await insertAgentRun(
      handle,
      agentRun({
        benchmarkRunId: corruptRunId,
        outputFiles: [file('first.txt'), file('second.txt', { content: null })],
      }),
    );
  } finally {
    handle.close();
  }
}, 60_000);

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  fsHooks.before = null;
  fsHooks.afterLstat = null;
  vi.restoreAllMocks();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  for (const dir of siblings.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A second scratch directory, removed with the first. */
function newScratchSibling(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'db-cli-export-other-')));
  siblings.push(dir);
  return dir;
}
const siblings: string[] = [];

function newScratch(): string {
  // Canonical, as the export reports it (macOS's temporary directory is behind a symlink).
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'db-cli-export-out-')));
  return scratch;
}

async function exportRun(runId: string, out: string, json = false) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const code = await benchmarkExportCommand({ runId, out, dataDir, ...(json ? { json } : {}) });
    return { code, output: log.mock.calls.map((call) => String(call[0])).join('\n') };
  } finally {
    log.mockRestore();
  }
}

async function exportError(runId: string, out: string): Promise<CliError> {
  const error = await exportRun(runId, out).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

const readManifest = (out: string) =>
  JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as ExportManifest;

/** Every entry below `dir`, as relative POSIX paths. */
function tree(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((p) => p.replaceAll('\\', '/'));
}

describe('isSafeRelativePath (SPEC-123 FR-123-42)', () => {
  it('accepts relative POSIX paths and refuses everything else', () => {
    expect(isSafeRelativePath('src/a.js')).toBe(true);
    expect(isSafeRelativePath('..a/b..x')).toBe(true);
    expect(isSafeRelativePath('.env')).toBe(true);
    expect(isSafeRelativePath('console.log.js')).toBe(true);
    expect(isSafeRelativePath('src/com10.txt')).toBe(true);
    for (const path of [
      '',
      ...UNSAFE_PATHS,
      '..',
      '.',
      '//server/share',
      'a/..',
      'ab:c',
      'file.txt:stream',
      'a<b',
      'a|b',
      'what?',
      'star*',
      'quote"',
      'esc\u001b[31m.txt',
      'dot.',
      'space ',
      'CON',
      'src/nul.txt',
      'Lpt1',
      'com9.js',
    ]) {
      expect(isSafeRelativePath(path), path).toBe(false);
    }
  });
});

describe('benchmark export (SPEC-123 §6.4)', () => {
  it('writes the demo run files and manifest into a new directory', async () => {
    const out = join(newScratch(), 'export');
    const { code, output } = await exportRun(demoRunId, out);
    expect(code).toBe(ExitCode.Ok);
    const manifest = readManifest(out);
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      runId: demoRunId,
      status: 'completed',
      baseline: { kind: 'none' },
      agent: { adapterId: 'mock', mock: true },
    });
    expect(manifest.agentRuns.length).toBe(manifest.summary.agentRuns);
    expect(manifest.summary.written).toBeGreaterThan(0);
    for (const run of manifest.agentRuns) {
      for (const entry of run.files.filter((f) => f.exportedTo !== null)) {
        expect(entry.exportedTo).toBe(
          `files/${run.caseId}/${run.variant}-${run.repetition}/${entry.path}`,
        );
        expect(existsSync(join(out, entry.exportedTo!))).toBe(true);
      }
    }
    expect(output).toContain(`Exported run ${demoRunId} to ${out}`);
    expect(output).toContain('Agent:            Mock agent: not an AI evaluation');
    expect(output).toContain(`Files written:    ${manifest.summary.written}`);
    expect(output).toContain(`Manifest:         ${join(out, 'manifest.json')}`);
  });

  it('prints only the summary object on stdout with --json, into an existing empty directory', async () => {
    const out = newScratch();
    const { code, output } = await exportRun(demoRunId, out, true);
    expect(code).toBe(ExitCode.Ok);
    const printed = JSON.parse(output) as Record<string, unknown>;
    expect(printed).toMatchObject({
      runId: demoRunId,
      out,
      manifest: join(out, 'manifest.json'),
      mock: true,
      status: 'completed',
      written: readManifest(out).summary.written,
    });
  });

  it('refuses unsafe stored paths and collisions, lists them and writes only safe files', async () => {
    const out = join(newScratch(), 'export');
    const { code, output } = await exportRun(hostileRunId, out);
    expect(code).toBe(ExitCode.Ok);
    const manifest = readManifest(out);
    expect(manifest.agent).toEqual({ adapterId: 'claude-code', version: null, mock: false });
    expect(manifest.baseline).toEqual({ kind: 'artifact-version', version: expect.any(Number) });
    expect(manifest.summary).toEqual({
      agentRuns: 5,
      files: 4 + 2 + UNSAFE_PATHS.length + 2 + 1 + 1,
      written: 4,
      truncated: 1,
      notKept: 2,
      unsafePath: UNSAFE_PATHS.length + 2,
      pathCollision: 2,
    });
    // Only the safe files exist, under files/, and nothing escaped the export directory.
    expect(tree(out).sort()).toEqual(
      [
        'files',
        'files/case-a',
        'files/case-a/candidate-1',
        'files/case-a/candidate-1/dir',
        'files/case-a/candidate-1/dir/nested.js',
        'files/case-a/candidate-1/foo',
        'files/case-a/candidate-1/ok.txt',
        'files/case-a/candidate-1/other.txt',
        'manifest.json',
      ].sort(),
    );
    expect(readdirSync(join(out, '..'))).toEqual(['export']);
    expect(readFileSync(join(out, 'files/case-a/candidate-1/ok.txt'), 'utf8')).toBe(
      'content of ok.txt',
    );
    const find = (caseId: string, variant: string) =>
      manifest.agentRuns.filter((r) => r.caseId === caseId && r.variant === variant);
    // The two agent runs with the same key come in database order; which one loses `ok.txt` to
    // the other is not part of the contract, so the assertions do not depend on it.
    const [first, second] = find('case-a', 'candidate').sort(
      (a, b) => b.files.length - a.files.length,
    );
    const [evil] = find('../evil', 'candidate');
    const [nested] = find('a/b', 'candidate');
    const [timedOut] = find('case-a', 'baseline');
    const byPath = new Map(first!.files.map((f) => [f.path, f]));
    expect(byPath.get('dir/nested.js')).toMatchObject({
      kept: 'truncated',
      reason: 'file-limit',
      redactions: 2,
      exportedTo: 'files/case-a/candidate-1/dir/nested.js',
      exportReason: null,
    });
    expect(byPath.get('bin.dat')).toMatchObject({
      kept: 'none',
      reason: 'binary',
      exportedTo: null,
      exportReason: null,
    });
    expect(byPath.get('foo/bar.txt')).toMatchObject({ exportReason: 'path-collision' });
    for (const path of UNSAFE_PATHS) {
      expect(byPath.get(path)).toMatchObject({ exportedTo: null, exportReason: 'unsafe-path' });
    }
    const okEntries = [byPath.get('ok.txt'), second!.files.find((f) => f.path === 'ok.txt')];
    expect(okEntries.map((f) => f!.exportReason).sort()).toEqual([null, 'path-collision'].sort());
    expect(second!.files.find((f) => f.path === 'other.txt')!.exportReason).toBeNull();
    expect(evil!.files[0]!.exportReason).toBe('unsafe-path');
    expect(nested!.files[0]!.exportReason).toBe('unsafe-path');
    expect(timedOut).toMatchObject({
      executionStatus: 'timeout',
      outputFilesKept: false,
      outputFilesReason: 'the agent did not stop after its timeout',
      files: [],
    });
    // The summary names each file that was not written, quoted for the terminal.
    expect(output).toContain('Agent:            claude-code (version unknown)');
    expect(output).toContain(`Unsafe paths:     ${UNSAFE_PATHS.length + 2} (not written)`);
    expect(output).toContain('Not written (unsafe-path): "case-a" candidate 1: "nul\\u0000.txt"');
    expect(output).toContain('Not written (unsafe-path): "../evil" candidate 1: "x.txt"');
    expect(output).toContain('Not written (path-collision): "case-a" candidate 1: "foo/bar.txt"');
    expect(output).toContain(
      'Warning: the run is still running; agent runs that finish later are not exported.',
    );
  });

  it('treats a name the file system already has as a collision (case-insensitive file systems)', async () => {
    const out = newScratch();
    fsHooks.before = (op, path) => {
      if (op === 'open' && path.endsWith('other.txt')) throw fsError('EEXIST');
    };
    expect((await exportRun(hostileRunId, out)).code).toBe(ExitCode.Ok);
    expect(readManifest(out).summary.pathCollision).toBe(3);
  });

  describe('refusals (exit 2, nothing written)', () => {
    it('refuses an unknown run id', async () => {
      const out = join(newScratch(), 'export');
      const error = await exportError('brun_missing', out);
      expect(error.exitCode).toBe(ExitCode.Usage);
      expect(error.message).toBe('No benchmark run brun_missing');
      expect(existsSync(out)).toBe(false);
    });

    it('refuses a missing or unmigrated database, naming init', async () => {
      const empty = newScratch();
      const error = await benchmarkExportCommand({
        runId: demoRunId,
        out: join(empty, 'export'),
        dataDir: join(empty, 'data'),
      }).catch((e: unknown) => e as CliError);
      expect((error as CliError).exitCode).toBe(ExitCode.Usage);
      expect((error as CliError).message).toContain('directivebench init');
      expect(readdirSync(empty)).toEqual([]);
    });

    it('refuses a non-empty directory and a file', async () => {
      const root = newScratch();
      const full = join(root, 'full');
      mkdirSync(full, { mode: 0o755 });
      writeFileSync(join(full, 'keep.txt'), 'mine');
      expect((await exportError(demoRunId, full)).message).toContain('is not empty');
      expect(readdirSync(full)).toEqual(['keep.txt']);

      const plain = join(root, 'plain');
      writeFileSync(plain, 'mine');
      expect((await exportError(demoRunId, plain)).message).toContain('is not a directory');
    });

    it('refuses a symbolic link, never following it', async () => {
      const root = newScratch();
      const target = join(root, 'target');
      mkdirSync(target);
      const link = join(root, 'link');
      // A junction needs no extra privileges on Windows; `lstat` reports it as a link too.
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      const linked = await exportError(demoRunId, link);
      expect(linked.exitCode).toBe(ExitCode.Usage);
      expect(linked.message).toContain('is a symbolic link, which export does not follow');
      expect(readdirSync(target)).toEqual([]);
    });

    it('refuses a missing parent without creating it', async () => {
      const root = newScratch();
      const error = await exportError(demoRunId, join(root, 'missing', 'export'));
      expect(error.exitCode).toBe(ExitCode.Usage);
      expect(error.message).toContain('parent directory');
      expect(readdirSync(root)).toEqual([]);
    });

    it('refuses a directory created between the check and the mkdir', async () => {
      const out = join(newScratch(), 'export');
      fsHooks.before = (op, path) => {
        if (op === 'mkdir' && path === out) mkdirSync(out);
      };
      const error = await exportError(demoRunId, out);
      expect(error.exitCode).toBe(ExitCode.Usage);
      expect(error.message).toContain('appeared');
    });

    it('refuses when manifest.json is created after the emptiness check (FR-123-41 race)', async () => {
      const out = newScratch();
      fsHooks.before = (op, path) => {
        if (op === 'open' && path === 'manifest.json') writeFileSync(join(out, path), 'other');
      };
      const error = await exportError(demoRunId, out);
      expect(error.exitCode).toBe(ExitCode.Usage);
      expect(error.message).toContain('another export');
      // Its own files/ is removed again; the other writer's manifest is untouched.
      expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe('other');
      expect(readdirSync(out)).toEqual(['manifest.json']);
    });

    it('refuses when files/ is created after the emptiness check', async () => {
      const out = newScratch();
      fsHooks.before = (op, path) => {
        if (op === 'mkdir' && path === 'files') mkdirSync(join(out, path));
      };
      const error = await exportError(demoRunId, out);
      expect(error.exitCode).toBe(ExitCode.Usage);
      expect(error.message).toContain('another export');
      expect(readdirSync(out)).toEqual(['files']);
      expect(readdirSync(join(out, 'files'))).toEqual([]);
    });
  });

  describe('runtime errors (exit 1, partial directory kept)', () => {
    it('reports the directory and the last file written, and deletes nothing', async () => {
      const out = newScratch();
      const error = await exportError(corruptRunId, out);
      expect(error.exitCode).toBe(ExitCode.Runtime);
      expect(error.message).toContain(`The export to ${out} failed after 1 file(s)`);
      expect(error.message).toContain('last written: files/case-a/candidate-1/first.txt');
      expect(error.message).toContain('"second.txt" has no content');
      expect(tree(out)).toContain('files/case-a/candidate-1/first.txt');
      expect(readFileSync(join(out, 'manifest.json'), 'utf8')).toBe('');
    });

    it('reports a failure before any file was written', async () => {
      const out = newScratch();
      fsHooks.before = (op, path) => {
        if (op === 'open' && path.endsWith('first.txt')) throw fsError('EIO');
      };
      const error = await exportError(corruptRunId, out);
      expect(error.exitCode).toBe(ExitCode.Runtime);
      expect(error.message).toContain('failed after 0 file(s) (last written: none)');
      expect(error.message).toContain('EIO: simulated');
    });

    it('turns a directory creation failure below files/ into a runtime error', async () => {
      const out = newScratch();
      fsHooks.before = (op, path) => {
        if (op === 'mkdir' && path.endsWith('case-a')) throw fsError('EACCES');
      };
      const error = await exportError(corruptRunId, out);
      expect(error.exitCode).toBe(ExitCode.Runtime);
      expect(error.message).toContain('EACCES: simulated');
    });

    it('rethrows unexpected file-system errors while preparing and claiming the target', async () => {
      const root = newScratch();
      writeFileSync(join(root, 'file'), '');
      // The parent's canonical path below a file: ENOTDIR, not a refusal.
      await expect(exportRun(demoRunId, join(root, 'file', 'sub', 'export'))).rejects.toMatchObject(
        { code: 'ENOTDIR' },
      );
      // lstat of the target below a file: ENOTDIR as well.
      await expect(exportRun(demoRunId, join(root, 'file', 'export'))).rejects.toMatchObject({
        code: 'ENOTDIR',
      });

      const out = join(root, 'out');
      fsHooks.before = (op, path) => {
        if (op === 'mkdir' && path === out) throw fsError('EACCES');
      };
      await expect(exportRun(demoRunId, out)).rejects.toMatchObject({ code: 'EACCES' });

      mkdirSync(out, { mode: 0o755 });
      fsHooks.before = (op, path) => {
        if (op === 'open' && path === 'manifest.json') throw fsError('EACCES');
      };
      await expect(exportRun(demoRunId, out)).rejects.toMatchObject({ code: 'EACCES' });
      // Its own files/ is removed again.
      expect(readdirSync(out)).toEqual([]);

      fsHooks.before = (op, path) => {
        if (op === 'mkdir' && path === 'files') throw fsError('ENOSPC');
      };
      await expect(exportRun(demoRunId, out)).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(readdirSync(out)).toEqual([]);
    });
  });

  // The export works inside its directory as the working directory, so renaming or replacing it,
  // or any directory above it, cannot redirect writes (Codex review rounds 2 and 3); what remains
  // is that no other user may change the export directory itself.
  describe('the export directory as the working directory', () => {
    function shared(mode: number): string {
      const dir = join(newScratch(), 'shared');
      mkdirSync(dir);
      chmodSync(dir, mode);
      return dir;
    }
    const refusal = (dir: string) =>
      `${dir} belongs to another user or can be changed by the group or others, who could redirect the export; choose a new directory (the export creates it private) or one only you can write to. Nothing was written.`;

    it('creates a private export directory, even below a directory others can write', async () => {
      const before = process.cwd();
      const out = join(shared(0o777), 'export');
      expect((await exportRun(demoRunId, out)).code).toBe(ExitCode.Ok);
      expect(process.cwd()).toBe(before);
      if (process.platform !== 'win32') {
        expect(statSync(out).mode & 0o777).toBe(0o700);
        expect(statSync(join(out, 'manifest.json')).mode & 0o777).toBe(0o600);
      }
    });

    it.skipIf(process.platform === 'win32')(
      'refuses an existing directory the group or others can write, or another user owns',
      async () => {
        const before = process.cwd();
        for (const mode of [0o777, 0o775, 0o1777]) {
          const target = shared(mode);
          const error = await exportError(demoRunId, target);
          expect(error.exitCode).toBe(ExitCode.Usage);
          expect(error.message).toBe(refusal(target));
          expect(readdirSync(target)).toEqual([]);
        }
        const owned = shared(0o755);
        fsHooks.afterLstat = (path, stats) => {
          if (path === '.') Object.assign(stats, { uid: stats.uid + 1 });
        };
        expect((await exportError(demoRunId, owned)).message).toBe(refusal(owned));
        expect(process.cwd()).toBe(before);
      },
    );

    it('skips the owner and mode check where the platform has no POSIX ids (Windows)', async () => {
      // Windows has no `process.getuid`; its ACLs are a documented residual (FR-123-42).
      vi.spyOn(process, 'getuid').mockReturnValue(undefined as never);
      expect((await exportRun(demoRunId, shared(0o777))).code).toBe(ExitCode.Ok);
    });

    it('stops when the directory entered is not the one looked at', async () => {
      const before = process.cwd();
      const out = newScratch();
      fsHooks.afterLstat = (path, stats) => {
        if (path === '.') Object.assign(stats, { ino: stats.ino + 1 });
      };
      await expect(exportRun(demoRunId, out)).rejects.toThrow(`${out} was replaced or moved`);
      expect(readdirSync(out)).toEqual([]);
      expect(process.cwd()).toBe(before);
    });
  });

  // Exclusive create protects only the last name of a path: another process that swaps a
  // directory of the chain, or the file itself, must never receive the content (Codex review
  // round 1). Node has no `openat`, so the export re-checks identities before writing.
  describe('replaced directories and files (exit 1, no content written into them)', () => {
    const candidateDir = (out: string) => join(out, 'files', 'case-a', 'candidate-1');

    it('stops when a directory of the chain is replaced before the file is opened', async () => {
      const out = newScratch();
      const outside = join(newScratchSibling(), 'moved');
      fsHooks.before = (op, path) => {
        if (op === 'open' && path.endsWith('first.txt')) {
          renameSync(candidateDir(out), outside);
          mkdirSync(candidateDir(out));
        }
      };
      const error = await exportError(corruptRunId, out);
      expect(error.exitCode).toBe(ExitCode.Runtime);
      expect(error.message).toContain(
        `${join('files', 'case-a', 'candidate-1')} was replaced or moved`,
      );
      expect(readFileSync(join(candidateDir(out), 'first.txt'), 'utf8')).toBe('');
      expect(readdirSync(outside)).toEqual([]);
    });

    it('stops when a directory of the chain becomes a symbolic link to another place', async () => {
      const out = newScratch();
      const elsewhere = newScratchSibling();
      fsHooks.before = (op, path) => {
        if (op === 'open' && path.endsWith('first.txt')) {
          rmSync(candidateDir(out), { recursive: true });
          symlinkSync(
            elsewhere,
            candidateDir(out),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
      };
      const error = await exportError(corruptRunId, out);
      expect(error.message).toContain(
        `${join('files', 'case-a', 'candidate-1')} was replaced or moved`,
      );
      // The file was created through the link, but no content reached it.
      expect(readFileSync(join(elsewhere, 'first.txt'), 'utf8')).toBe('');
    });

    it('stops when the opened file is replaced before its content is written', async () => {
      const out = newScratch();
      fsHooks.before = (op, path) => {
        if (op === 'lstat' && path.endsWith('first.txt')) {
          renameSync(path, `${path}.opened`);
          writeFileSync(path, 'someone else');
        }
      };
      const error = await exportError(corruptRunId, out);
      expect(error.message).toContain('first.txt was replaced or moved');
      expect(readFileSync(join(candidateDir(out), 'first.txt'), 'utf8')).toBe('someone else');
      expect(readFileSync(join(candidateDir(out), 'first.txt.opened'), 'utf8')).toBe('');
    });

    it('does not write the manifest when manifest.json was replaced', async () => {
      const out = newScratch();
      const manifestPath = join(out, 'manifest.json');
      fsHooks.before = (op, path) => {
        if (op === 'lstat' && path === 'manifest.json') {
          renameSync(manifestPath, `${manifestPath}.opened`);
          writeFileSync(manifestPath, 'someone else');
        }
      };
      const error = await exportError(demoRunId, out);
      expect(error.exitCode).toBe(ExitCode.Runtime);
      expect(readFileSync(manifestPath, 'utf8')).toBe('someone else');
      expect(readFileSync(`${manifestPath}.opened`, 'utf8')).toBe('');
    });

    it('refuses a created directory that is not a directory owned by the user', async () => {
      const out = newScratch();
      fsHooks.afterLstat = (path, stats) => {
        if (path === 'files') Object.assign(stats, { uid: stats.uid + 1 });
      };
      await expect(exportRun(demoRunId, out)).rejects.toThrow(/files was replaced or moved/);

      const second = join(out, 'second');
      fsHooks.afterLstat = (path, stats) => {
        if (path === 'files') Object.assign(stats, { isDirectory: () => false });
      };
      await expect(exportRun(demoRunId, second)).rejects.toThrow(/files was replaced or moved/);
    });
  });
});
