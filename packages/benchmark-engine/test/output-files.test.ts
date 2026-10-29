import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeAdapter,
  MockAgentAdapter,
  pinWorkspace,
  type AgentAdapter,
  type WorkspacePin,
} from '@directivebench/agent-adapters';
import { SECRET_PATTERN_MIN_LENGTHS, type TextRange } from '@directivebench/core';
import { buildManifest, diffManifests, type ManifestFile } from '../src/files';
import {
  captureOutputFiles,
  KEY_MARKER_MAX_BYTES,
  KeyMarkerScan,
  NOT_CAPTURED,
  notKeptOutput,
  OUTPUT_FILE_MAX_BYTES,
  OUTPUT_REDACTION_MARGIN_BYTES,
  OUTPUT_RUN_MAX_BYTES,
  placeCut,
  summarizeCapture,
  trimIncompleteUtf8,
  utf16Ranges,
  type CapturedFile,
  type CaptureInput,
  type CaptureOutcome,
} from '../src/output-files';
import { useTempDirs } from './helpers';

const tmp = useTempDirs();
const MiB = 1_048_576;
const L = OUTPUT_FILE_MAX_BYTES;
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

type Finder = Pick<AgentAdapter, 'findOutputSecrets'>;
const KNOWN = 'custom-known-secret-value-42';
const mock = new MockAgentAdapter();
const claude = (key = KNOWN) =>
  new ClaudeCodeAdapter({ authMode: 'api-key' }, { ANTHROPIC_API_KEY: key, PATH: '' });
const none: Finder = { findOutputSecrets: () => [] };
const ADAPTERS: [string, Finder][] = [
  ['mock agent', mock],
  ['Claude Code', claude()],
  ['an adapter returning no range', none],
];

interface Workspace {
  pin: WorkspacePin;
  before: ManifestFile[];
  write: (path: string, content: string | Buffer) => void;
}

/** A pinned workspace holding `initial`, with its manifest taken as the engine takes `before`. */
async function workspace(initial: Record<string, string | Buffer> = {}): Promise<Workspace> {
  const dir = join(tmp('ws'), 'workspace');
  mkdirSync(dir);
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  for (const [path, content] of Object.entries(initial)) write(path, content);
  return { pin: await pinWorkspace(dir), before: await buildManifest(dir), write };
}

function capture(
  ws: Workspace,
  options: Partial<Omit<CaptureInput, 'workspace' | 'before'>> = {},
): Promise<CaptureOutcome> {
  return captureOutputFiles({
    workspace: ws.pin,
    before: ws.before,
    measured: null,
    installedPaths: [],
    adapter: mock,
    ...options,
  });
}

async function capturedFiles(ws: Workspace, options: Parameters<typeof capture>[1] = {}) {
  const outcome = await capture(ws, options);
  if (!outcome.ok) throw new Error(`capture failed: ${outcome.reason}`);
  return outcome.capture.files;
}

async function onlyFile(text: string | Buffer, adapter: Finder = mock): Promise<CapturedFile> {
  const ws = await workspace();
  ws.write('out.txt', text);
  const [file] = await capturedFiles(ws, { adapter });
  return file as CapturedFile;
}

describe('captureOutputFiles: what is kept (SPEC-123 FR-123-04/05/08)', () => {
  it('keeps changed text files in full and lists deleted, binary and artifact files without content', async () => {
    const ws = await workspace({
      'keep.txt': 'old',
      'gone.txt': 'x',
      '.agent/skill.md': 's0',
      '.agent/removed.md': 'r',
    });
    rmSync(join(ws.pin.path, '.agent/removed.md'));
    ws.write('keep.txt', 'new text');
    rmSync(join(ws.pin.path, 'gone.txt'));
    ws.write('bin.dat', Buffer.from([0x61, 0x00, 0x62]));
    ws.write('bad.txt', Buffer.from([0xff, 0xfe, 0x41]));
    ws.write('empty.txt', '');
    ws.write('.agent/skill.md', 's1');
    ws.write('.agent/sub/extra.md', 'extra');
    ws.write('.agents-not-artifact.md', 'kept');

    const outcome = await capture(ws, { installedPaths: ['.agent'] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const meta = (path: string, content: string) => ({
      sizeBytes: Buffer.byteLength(content),
      sha256: sha(content),
    });
    expect(outcome.capture.files).toEqual([
      {
        path: '.agent/removed.md',
        change: 'deleted',
        sizeBytes: null,
        sha256: null,
        kept: 'none',
        reason: 'artifact-path',
        content: null,
        storedBytes: 0,
        redactions: 0,
      },
      {
        path: '.agent/skill.md',
        change: 'modified',
        ...meta('.agent/skill.md', 's1'),
        kept: 'none',
        reason: 'artifact-path',
        content: null,
        storedBytes: 0,
        redactions: 0,
      },
      {
        path: '.agent/sub/extra.md',
        change: 'added',
        ...meta('', 'extra'),
        kept: 'none',
        reason: 'artifact-path',
        content: null,
        storedBytes: 0,
        redactions: 0,
      },
      {
        path: '.agents-not-artifact.md',
        change: 'added',
        ...meta('', 'kept'),
        kept: 'full',
        reason: null,
        content: 'kept',
        storedBytes: 4,
        redactions: 0,
      },
      {
        path: 'bad.txt',
        change: 'added',
        sizeBytes: 3,
        sha256: sha(Buffer.from([0xff, 0xfe, 0x41])),
        kept: 'none',
        reason: 'binary',
        content: null,
        storedBytes: 0,
        redactions: 0,
      },
      {
        path: 'bin.dat',
        change: 'added',
        sizeBytes: 3,
        sha256: sha(Buffer.from([0x61, 0x00, 0x62])),
        kept: 'none',
        reason: 'binary',
        content: null,
        storedBytes: 0,
        redactions: 0,
      },
      {
        path: 'empty.txt',
        change: 'added',
        ...meta('', ''),
        kept: 'full',
        reason: null,
        content: '',
        storedBytes: 0,
        redactions: 0,
      },
      {
        path: 'gone.txt',
        change: 'deleted',
        sizeBytes: null,
        sha256: null,
        kept: 'none',
        reason: 'deleted',
        content: null,
        storedBytes: 0,
        redactions: 0,
      },
      {
        path: 'keep.txt',
        change: 'modified',
        ...meta('', 'new text'),
        kept: 'full',
        reason: null,
        content: 'new text',
        storedBytes: 8,
        redactions: 0,
      },
    ]);
    expect(outcome.changes.map((c) => [c.path, c.change])).toEqual(
      outcome.capture.files.map((f) => [f.path, f.change]),
    );
    expect(summarizeCapture(outcome.capture)).toEqual({
      status: 'kept',
      reason: null,
      files: 9,
      truncated: 0,
      notKept: 6,
      storedBytes: 12,
    });
  });

  it('keeps nothing and fails nothing when the agent changed no file', async () => {
    const ws = await workspace({ 'a.txt': 'a' });
    const outcome = await capture(ws);
    expect(outcome).toEqual({ ok: true, capture: { files: [] }, changes: [] });
    if (outcome.ok) {
      expect(summarizeCapture(outcome.capture)).toMatchObject({ status: 'kept', files: 0 });
    }
  });

  it('reuses the measurement manifest of a completed run and builds no second one (FR-123-02)', async () => {
    const ws = await workspace();
    ws.write('a.txt', 'a');
    ws.write('b.txt', 'b');
    const after = await buildManifest(ws.pin.path);
    // Only the change list passed in is captured.
    const changes = diffManifests(ws.before, after).filter((c) => c.path === 'b.txt');
    const outcome = await capture(ws, { measured: { after, changes } });
    expect(outcome.ok && outcome.capture.files.map((f) => f.path)).toEqual(['b.txt']);
  });

  it('keeps a file of exactly 1 MiB in full and cuts one byte more at 1 MiB (file-limit)', async () => {
    const ws = await workspace();
    ws.write('exact.txt', 'a'.repeat(MiB));
    ws.write('over.txt', 'b'.repeat(MiB + 1));
    const [exact, over] = await capturedFiles(ws);
    expect(exact).toMatchObject({ kept: 'full', reason: null, storedBytes: MiB });
    expect(exact?.content).toHaveLength(MiB);
    expect(over).toMatchObject({
      kept: 'truncated',
      reason: 'file-limit',
      sizeBytes: MiB + 1,
      sha256: sha('b'.repeat(MiB + 1)),
      storedBytes: MiB,
      content: 'b'.repeat(MiB),
    });
  });

  it('cuts on a character boundary and trims a character the read window splits', async () => {
    // 1 MiB is not a multiple of 3 bytes, nor is the read window.
    expect(L % 3).toBe(1);
    expect((L + OUTPUT_REDACTION_MARGIN_BYTES) % 3).not.toBe(0);
    const file = await onlyFile('€'.repeat(400_000));
    expect(file).toMatchObject({ kept: 'truncated', storedBytes: L - 1 });
    expect(file.content).toBe('€'.repeat((L - 1) / 3));
  });

  it('applies the 10 MiB run budget in ascending size order, then path (A4, run-limit)', async () => {
    const ws = await workspace();
    for (let i = 8; i >= 0; i -= 1) ws.write(`f${i}.txt`, 'a'.repeat(MiB));
    ws.write('small.txt', 's'.repeat(100));
    ws.write('a-big.txt', 'b'.repeat(MiB + MiB / 2));
    ws.write('a-huge.txt', 'h'.repeat(2 * MiB));
    const files = await capturedFiles(ws);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('small.txt')).toMatchObject({ kept: 'full', storedBytes: 100 });
    for (let i = 0; i < 9; i += 1) {
      expect(byPath.get(`f${i}.txt`)).toMatchObject({ kept: 'full', storedBytes: MiB });
    }
    // 9 MiB + 100 bytes used: the next file gets the rest of the run budget.
    expect(byPath.get('a-big.txt')).toMatchObject({
      kept: 'truncated',
      reason: 'run-limit',
      storedBytes: MiB - 100,
    });
    expect(byPath.get('a-huge.txt')).toMatchObject({
      kept: 'none',
      reason: 'run-limit',
      content: null,
      storedBytes: 0,
      sizeBytes: 2 * MiB,
    });
    expect(files.reduce((sum, f) => sum + f.storedBytes, 0)).toBe(OUTPUT_RUN_MAX_BYTES);
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort());
  });
});

describe('captureOutputFiles: redaction at the cut (FR-123-06/07)', () => {
  it('reads far enough past the cut to recognise every core secret pattern', () => {
    expect(OUTPUT_REDACTION_MARGIN_BYTES).toBeGreaterThanOrEqual(
      Math.max(...SECRET_PATTERN_MIN_LENGTHS),
    );
  });

  it('never splits a known secret that straddles the cut', async () => {
    const text = `${'a'.repeat(L - 10)}${KNOWN}${'b'.repeat(100)}`;
    expect(await onlyFile(text, claude())).toMatchObject({
      kept: 'truncated',
      content: 'a'.repeat(L - 10),
      redactions: 0,
    });
    // The mock does not know the value, so its first bytes are kept: only the adapter knows it.
    expect((await onlyFile(text, mock)).content).toBe(`${'a'.repeat(L - 10)}${KNOWN.slice(0, 10)}`);
  });

  it('never splits a pattern token that straddles the cut', async () => {
    const token = `ghp_${'T'.repeat(36)}`;
    for (const [, adapter] of ADAPTERS) {
      const file = await onlyFile(`${'a'.repeat(L - 10)} ${token} tail`, adapter);
      expect(file.content).toBe(`${'a'.repeat(L - 10)} `);
    }
  });

  it('treats the start of a known secret cut by the end of the read window as the secret', async () => {
    // Longer than the margin: the window holds only a prefix of it.
    const long = `long-secret-${'Z'.repeat(OUTPUT_REDACTION_MARGIN_BYTES + 900)}`;
    const file = await onlyFile(`${'a'.repeat(L - 10)}${long} tail`, claude(long));
    expect(file).toMatchObject({ kept: 'truncated', content: 'a'.repeat(L - 10) });
  });

  it('counts original bytes for the cut when a redaction shortens the text', async () => {
    const token = `ghp_${'T'.repeat(36)}`;
    const file = await onlyFile(`${token} ${'a'.repeat(L - 41 + 20)}`);
    expect(file).toMatchObject({
      kept: 'truncated',
      reason: 'file-limit',
      redactions: 1,
      storedBytes: L - 30,
    });
    expect(file.content === `[REDACTED] ${'a'.repeat(L - 41)}`).toBe(true);
  });

  it('counts stored bytes for the cut when a redaction lengthens the text', async () => {
    const short = 'abcdefgh';
    // The whole file fits by original bytes, but its redacted text does not.
    const file = await onlyFile(`${short}${'x'.repeat(L - 8)}`, claude(short));
    expect(file).toMatchObject({
      kept: 'truncated',
      reason: 'file-limit',
      redactions: 1,
      content: `[REDACTED]${'x'.repeat(L - 10)}`,
      storedBytes: L,
    });
  });

  it('redacts secrets in full files, and never counts a [REDACTED] the agent wrote', async () => {
    const file = await onlyFile(
      `the agent wrote [REDACTED]; key ${KNOWN}; token xoxb-1234567890-abc`,
      claude(),
    );
    expect(file).toMatchObject({
      kept: 'full',
      redactions: 2,
      content: 'the agent wrote [REDACTED]; key [REDACTED]; token [REDACTED]',
    });
    expect(await onlyFile('only [REDACTED] text')).toMatchObject({ kept: 'full', redactions: 0 });
  });

  it.each([
    ['a fractional offset', { start: 0.5, end: 2 }],
    ['a fractional end', { start: 0, end: 1.5 }],
    ['a negative start', { start: -1, end: 2 }],
    ['an empty range', { start: 2, end: 2 }],
    ['an end past the text', { start: 0, end: 999 }],
  ])('fails the capture on an adapter range with %s', async (_, range: TextRange) => {
    const ws = await workspace();
    ws.write('a.txt', 'some text');
    // Invalid only on the file's text, so the failure reason itself can still be redacted.
    const adapter: Finder = {
      findOutputSecrets: (text) => (text === 'some text' ? [range] : []),
    };
    const outcome = await capture(ws, { adapter });
    expect(outcome).toEqual({
      ok: false,
      reason: 'the agent adapter returned an invalid secret range',
    });
  });
});

describe('captureOutputFiles: private keys cut by the bounded read (FR-123-07 regressions)', () => {
  const BEGIN = '-----BEGIN PRIVATE KEY-----';
  const END = '-----END PRIVATE KEY-----';
  /** Key body bytes: none of these characters appear anywhere else in the files. */
  const body = (bytes: number) => 'q0+/'.repeat(bytes / 4);
  const ANCHOR = `intro\n${BEGIN}\nfirst\n${END}\n`;
  const filler = (to: number, used: number) => '.'.repeat(to - used);

  for (const [name, adapter] of ADAPTERS) {
    describe(`with ${name}`, () => {
      it('keeps no body byte of a BEGIN block whose END lies beyond the read window (round 1)', async () => {
        const head = filler(L - 64 - BEGIN.length, 0);
        const text = `${head}${BEGIN}${body(8192)}${END}\nend\n`;
        const file = await onlyFile(text, adapter);
        expect(file.kept).toBe('truncated');
        expect(file.content).toBe(`${head}${BEGIN}`);
      });

      it('keeps no byte of a fragment whose END lies beyond the read window (round 2)', async () => {
        const head = `${ANCHOR}${filler(L - 64, ANCHOR.length)}`;
        const text = `${head}${body(64 + 8192)}${END}\nend\n`;
        const file = await onlyFile(text, adapter);
        expect(file.content).not.toMatch(/[q0+/]/);
        expect(file.content).toBe(`intro\n${BEGIN}[REDACTED]${END}`);
      });

      it('keeps no byte of a fragment whose END straddles the end of the read window (round 2)', async () => {
        const windowEnd = L + OUTPUT_REDACTION_MARGIN_BYTES;
        const head = `${ANCHOR}${filler(L - 64, ANCHOR.length)}`;
        const fragment = body(windowEnd - 12 - (L - 64));
        const text = `${head}${fragment}${END}${body(4096)}`;
        expect(text.lastIndexOf(END)).toBe(windowEnd - 12);
        const file = await onlyFile(text, adapter);
        expect(file.content).toBe(`intro\n${BEGIN}[REDACTED]${END}`);
      });

      it('keeps no byte of a fragment before an overlong END marker that starts inside the window (round 3)', async () => {
        const head = `${ANCHOR}${filler(L - 64 - 64, ANCHOR.length)}`;
        const text = `${head}${body(64)}-----END ${'A'.repeat(8192)} PRIVATE KEY-----\nend\n`;
        const file = await onlyFile(text, adapter);
        expect(file.content).not.toMatch(/[q0+/]/);
        expect(
          file.content?.startsWith(`intro\n${BEGIN}[REDACTED]${END}[REDACTED]-----END AAA`),
        ).toBe(true);
      });
    });
  }
});

describe('captureOutputFiles: failures never throw (FR-123-09)', () => {
  it('fails when a file changed size after the manifest', async () => {
    const ws = await workspace();
    ws.write('a.txt', 'one');
    const after = await buildManifest(ws.pin.path);
    ws.write('a.txt', 'one more');
    expect(
      await capture(ws, { measured: { after, changes: diffManifests(ws.before, after) } }),
    ).toEqual({ ok: false, reason: 'a.txt changed after the agent stopped' });
  });

  it('fails when a byte after the read window changed (the hash covers the whole file)', async () => {
    const ws = await workspace();
    const content = Buffer.from('a'.repeat(2 * MiB));
    ws.write('big.txt', content);
    const after = await buildManifest(ws.pin.path);
    content[content.length - 1] = 0x62;
    ws.write('big.txt', content);
    expect(
      await capture(ws, { measured: { after, changes: diffManifests(ws.before, after) } }),
    ).toEqual({ ok: false, reason: 'big.txt changed after the agent stopped' });
  });

  it('fails when a file was replaced by a link, naming the error code and no absolute path', async () => {
    const ws = await workspace();
    ws.write('a.txt', 'one');
    const after = await buildManifest(ws.pin.path);
    const outside = join(tmp('outside'), 'secret.txt');
    writeFileSync(outside, 'one');
    rmSync(join(ws.pin.path, 'a.txt'));
    symlinkSync(outside, join(ws.pin.path, 'a.txt'));
    expect(
      await capture(ws, { measured: { after, changes: diffManifests(ws.before, after) } }),
    ).toEqual({ ok: false, reason: 'a.txt could not be read (ELOOP)' });
  });

  it('fails when a directory on the path was replaced by a link', async () => {
    const ws = await workspace();
    ws.write('dir/a.txt', 'one');
    const after = await buildManifest(ws.pin.path);
    const outside = tmp('outside');
    writeFileSync(join(outside, 'a.txt'), 'one');
    renameSync(join(ws.pin.path, 'dir'), join(ws.pin.path, 'moved'));
    symlinkSync(outside, join(ws.pin.path, 'dir'));
    expect(
      await capture(ws, { measured: { after, changes: diffManifests(ws.before, after) } }),
    ).toEqual({ ok: false, reason: 'dir/a.txt is not the file the manifest listed' });
  });

  it('fails with the manifest error of an agent-error or timeout run (own manifest)', async () => {
    const ws = await workspace();
    symlinkSync('/etc', join(ws.pin.path, 'link'));
    expect(await capture(ws)).toEqual({
      ok: false,
      reason: 'Symbolic links are not allowed: link',
    });
  });

  it('redacts the reason with the core rules and the adapter', async () => {
    const ws = await workspace();
    const token = `ghp_${'T'.repeat(30)}`;
    ws.write(`${token}.txt`, 'one');
    ws.write(`${KNOWN}.txt`, 'two');
    const after = await buildManifest(ws.pin.path);
    ws.write(`${token}.txt`, 'one more');
    const outcome = await capture(ws, {
      adapter: claude(),
      measured: { after, changes: diffManifests(ws.before, after) },
    });
    expect(outcome).toEqual({
      ok: false,
      reason: '[REDACTED].txt changed after the agent stopped',
    });
  });

  it('falls back to a generic reason when the adapter cannot redact it', async () => {
    const ws = await workspace();
    ws.write('a.txt', 'one');
    const throwing: Finder = {
      findOutputSecrets: () => {
        throw new Error('adapter failure');
      },
    };
    expect(await capture(ws, { adapter: throwing })).toEqual({
      ok: false,
      reason: 'the output files could not be captured',
    });
  });

  it('reports what an adapter threw, wrapped as a read failure, when it can still redact', async () => {
    const ws = await workspace();
    ws.write('a.txt', 'one');
    let calls = 0;
    const flaky: Finder = {
      findOutputSecrets: () => {
        calls += 1;
        // Not an Error: thrown values of any kind end in the reason as text.
        if (calls === 1) throw 'flaky';
        return [];
      },
    };
    expect(await capture(ws, { adapter: flaky })).toEqual({
      ok: false,
      reason: 'a.txt could not be read (flaky)',
    });
  });

  it('keeps the message of a non-Error thrown outside the file reads', async () => {
    const ws = await workspace({ 'a.txt': 'one' });
    ws.write('a.txt', 'two');
    // A manifest whose use throws a string makes the capture fail before any read.
    const after = {
      map: () => {
        throw 'not an error';
      },
    } as unknown as ManifestFile[];
    expect(await capture(ws, { measured: { after, changes: [] } })).toEqual({
      ok: false,
      reason: 'not an error',
    });
  });
});

describe('summaries', () => {
  it('describes a run without a consumer and a run whose files were not kept', () => {
    expect(NOT_CAPTURED).toEqual({
      status: 'not-captured',
      reason: 'no-consumer',
      files: 0,
      truncated: 0,
      notKept: 0,
      storedBytes: 0,
    });
    expect(notKeptOutput('why')).toEqual({ ...NOT_CAPTURED, status: 'not-kept', reason: 'why' });
  });
});

describe('trimIncompleteUtf8', () => {
  const bytes = (...values: number[]) => Buffer.from(values);
  it.each([
    ['ASCII', bytes(0x61, 0x62), 2],
    ['a complete 2-byte character', Buffer.from('aé'), 3],
    ['a complete 3-byte character', Buffer.from('a€'), 4],
    ['a complete 4-byte character', Buffer.from('a😀'), 5],
    ['an incomplete 2-byte character', Buffer.from('aé').subarray(0, 2), 1],
    ['an incomplete 3-byte character', Buffer.from('a€').subarray(0, 3), 1],
    ['an incomplete 4-byte character', Buffer.from('a😀').subarray(0, 4), 1],
    ['continuation bytes only', bytes(0x80, 0x80), 2],
    ['an empty buffer', bytes(), 0],
  ])('%s', (_, input, length) => {
    expect(trimIncompleteUtf8(input)).toHaveLength(length);
  });
});

describe('placeCut', () => {
  it('stops before a character that does not fit, counting UTF-8 bytes', () => {
    expect(placeCut('aé€😀', [], 1)).toEqual({ content: 'a', end: 1, redactions: 0 });
    expect(placeCut('aé€😀', [], 3)).toEqual({ content: 'aé', end: 2, redactions: 0 });
    expect(placeCut('aé€😀', [], 9)).toEqual({ content: 'aé€', end: 3, redactions: 0 });
    expect(placeCut('aé€😀', [], 12)).toEqual({ content: 'aé€😀', end: 5, redactions: 0 });
    expect(placeCut('aé€😀', [], 10)).toEqual({ content: 'aé€😀', end: 5, redactions: 0 });
  });

  it('counts a lone surrogate as three bytes', () => {
    expect(placeCut('a\uD83Dx', [], 3)).toEqual({ content: 'a', end: 1, redactions: 0 });
    // A range that starts inside a surrogate pair: the high surrogate stands alone.
    expect(placeCut('a😀', [{ start: 2, end: 3 }], 2)).toEqual({
      content: 'a',
      end: 1,
      redactions: 0,
    });
  });

  it('ends the prefix at the start of a secret range that does not fit', () => {
    // Fits by original bytes, but the marker does not fit the stored budget.
    expect(placeCut('xabc', [{ start: 1, end: 4 }], 5)).toEqual({
      content: 'x',
      end: 1,
      redactions: 0,
    });
    // Does not fit by original bytes.
    expect(placeCut('x'.repeat(20), [{ start: 0, end: 20 }], 15)).toEqual({
      content: '',
      end: 0,
      redactions: 0,
    });
    expect(placeCut('ab secret-value cd', [{ start: 3, end: 15 }], 100)).toEqual({
      content: 'ab [REDACTED] cd',
      end: 18,
      redactions: 1,
    });
  });
});

describe('KeyMarkerScan', () => {
  const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
  const END = '-----END RSA PRIVATE KEY-----';

  /** Fragments of `text` for a window of `windowEnd` bytes, the text pushed in `chunks`. */
  function fragments(text: string, windowEnd: number, chunks: number[] = []): string[] {
    const bytes = Buffer.from(text, 'latin1');
    const scan = new KeyMarkerScan(windowEnd);
    let from = 0;
    for (const at of [...chunks, bytes.length]) {
      scan.push(bytes.subarray(from, at));
      from = at;
    }
    return scan.end().map((r) => text.slice(r.start, r.end));
  }

  it('finds the fragments of every marker order, as trace redaction does', () => {
    const text = `a${BEGIN}b${END}c${END}d${BEGIN}e`;
    expect(fragments(text, text.length)).toEqual(['b', 'c', 'e']);
    expect(fragments(`plain ${BEGIN.slice(0, 20)} text`, 40)).toEqual([]);
  });

  it('finds the same markers wherever a chunk boundary falls', () => {
    const text = `xx${BEGIN}body${END}yy${END}zz`;
    const expected = fragments(text, text.length);
    expect(expected).toEqual(['body', 'yy']);
    for (let at = 1; at < text.length; at += 1) {
      expect(fragments(text, text.length, [at])).toEqual(expected);
    }
    // Byte by byte, too.
    expect(
      fragments(
        text,
        text.length,
        [...text].map((_, i) => i + 1),
      ),
    ).toEqual(expected);
  });

  it('classifies the window by the first marker that ends after it', () => {
    const text = `head${END}fragment${END}tail`;
    const windowEnd = `head${END}frag`.length;
    expect(fragments(text, windowEnd)).toEqual(['head', 'frag']);
    // An END marker straddling the window end makes the text before it a fragment too.
    expect(fragments(text, `head${END}fragment-----E`.length)).toEqual(['head', 'fragment']);
    // A BEGIN after the window says nothing about the text before it.
    expect(fragments(`head${BEGIN}x`, 3)).toEqual([]);
  });

  it('stops classifying once a marker ends after the window', () => {
    const scan = new KeyMarkerScan(4);
    scan.push(Buffer.from(`ab${END}`));
    scan.push(Buffer.from(`c${END}`));
    expect(scan.end()).toEqual([{ start: 0, end: 2 }]);
  });

  it('counts a start undecided after KEY_MARKER_MAX_BYTES as an END marker ending there', () => {
    const overlong = `-----BEGIN ${'A'.repeat(KEY_MARKER_MAX_BYTES)} PRIVATE KEY-----`;
    const text = `frag${overlong}after`;
    const scan = new KeyMarkerScan(text.length);
    scan.push(Buffer.from(text));
    expect(scan.end()).toEqual([{ start: 0, end: 4 }]);
    // `PRIVATE KEY` reached, but its dashes would end past the limit.
    const late = `-----END ${'A'.repeat(KEY_MARKER_MAX_BYTES - 9 - 11 - 3)}PRIVATE KEY-----`;
    expect(fragments(`f${late}x`, late.length + 2)).toEqual(['f']);
    // A marker of exactly the maximum length is a marker of its kind.
    const exact = `-----BEGIN ${'A'.repeat(KEY_MARKER_MAX_BYTES - 11 - 11 - 5)}PRIVATE KEY-----`;
    expect(exact).toHaveLength(KEY_MARKER_MAX_BYTES);
    expect(fragments(`f${exact}body`, exact.length + 5)).toEqual(['body']);
  });

  it('counts a start the file ends inside as an END marker', () => {
    expect(fragments('fragment-----END ABC', 20)).toEqual(['fragment']);
    expect(fragments('fragment-----END ABC PRIVATE KEY', 32)).toEqual(['fragment']);
  });

  it('ignores text that cannot be a marker', () => {
    for (const text of [
      'a-----BEGIN PUBLIC KEY-----b',
      'a-----BEGIN CERTIFICATE-----b',
      'a-----END X-----b',
      'a-----END PRIVATE KEY----b',
      'a-----END PRIVATE KEYS-----b',
      'a-----BEGIN private key-----b',
      'a----- BEGIN-----b',
      'a-----',
      'a-----BEG',
    ]) {
      expect(fragments(text, text.length), text).toEqual([]);
      expect(fragments(text, text.length, [text.length - 2]), text).toEqual([]);
    }
  });

  it('finds a marker after one more dash', () => {
    expect(fragments(`x-${END}`, END.length + 2)).toEqual(['x-']);
  });
});

describe('utf16Ranges', () => {
  it('converts byte offsets to UTF-16 offsets across multi-byte characters', () => {
    const text = 'aé€😀b';
    const bytes = Buffer.from(text);
    const ranges = utf16Ranges(bytes, [
      { start: 0, end: 1 },
      { start: 3, end: 6 },
      { start: 6, end: 11 },
    ]);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(['a', '€', '😀b']);
  });
});
