import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISCOVERY_LIMITS, discoverArtifacts, SKIPPED_DIRECTORY_NAMES } from '../src/discovery';
import { hashManifest, sha256 } from '../src/hash';
import { buildDiscoveryFixture, SKILL } from './discovery-fixture';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'db-discovery-'));
  outside = await mkdtemp(join(tmpdir(), 'db-discovery-outside-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function write(relPath: string, content: string | Uint8Array): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe('discoverArtifacts on the fixture tree', () => {
  it('discovers every supported format, sorted by path, and ignores decoys', async () => {
    await buildDiscoveryFixture(root, outside);
    const result = await discoverArtifacts(root);

    expect(
      result.artifacts.map((artifact) => [
        artifact.primaryPath,
        artifact.parsed.format,
        artifact.parsed.type,
        artifact.occurrencePath,
        artifact.primaryFile,
      ]),
    ).toEqual([
      [
        '.agents/skills/validate/SKILL.md',
        'skill-md',
        'skill',
        '.agents/skills/validate',
        'SKILL.md',
      ],
      [
        '.agents/skills/validate/nested/SKILL.md',
        'skill-md',
        'skill',
        '.agents/skills/validate/nested',
        'SKILL.md',
      ],
      ['.claude/rules/style.md', 'claude-rule', 'rule', '.claude/rules/style.md', 'style.md'],
      ['.cursor/rules/react.mdc', 'cursor-rule', 'rule', '.cursor/rules/react.mdc', 'react.mdc'],
      [
        '.github/copilot-instructions.md',
        'copilot-instructions',
        'instruction',
        '.github/copilot-instructions.md',
        'copilot-instructions.md',
      ],
      [
        '.github/instructions/php.instructions.md',
        'copilot-path-instructions',
        'rule',
        '.github/instructions/php.instructions.md',
        'php.instructions.md',
      ],
      [
        '.gitlab/duo/chat-rules.md',
        'gitlab-duo-chat-rules',
        'rule',
        '.gitlab/duo/chat-rules.md',
        'chat-rules.md',
      ],
      ['AGENTS.md', 'agents-md', 'instruction', 'AGENTS.md', 'AGENTS.md'],
      ['CLAUDE.md', 'claude-md', 'instruction', 'CLAUDE.md', 'CLAUDE.md'],
      ['packages/api/AGENTS.md', 'agents-md', 'instruction', 'packages/api/AGENTS.md', 'AGENTS.md'],
    ]);
    expect(result.errors).toEqual([
      {
        path: 'linked/CLAUDE.md',
        code: 'symlink',
        message: 'linked/CLAUDE.md is a symbolic link and is not followed',
      },
    ]);
    // Regular files outside .git/ and node_modules/, decoys included.
    expect(result.scannedFiles).toBe(21);
  });

  it('collects every regular file of a skill except nested skills, binaries and symlinks', async () => {
    await buildDiscoveryFixture(root, outside);
    const { artifacts } = await discoverArtifacts(root);
    const skill = artifacts[0]!;

    expect(skill.parsed.name).toBe('validate-external-input');
    expect(skill.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/api.md',
      'scripts/run.sh',
    ]);
    expect(skill.files[0]).toEqual({
      path: 'SKILL.md',
      sha256: sha256(SKILL),
      size: Buffer.byteLength(SKILL),
      content: SKILL,
    });
    expect(skill.contentHash).toBe(hashManifest(skill.files));
    expect(skill.skipped).toEqual([
      { path: 'assets/latin1.txt', reason: 'binary' },
      { path: 'assets/logo.png', reason: 'binary' },
      { path: 'link.md', reason: 'symlink' },
    ]);
    expect(skill.warnings).toEqual([
      'Skipped binary file assets/latin1.txt',
      'Skipped binary file assets/logo.png',
      'Skipped symbolic link link.md',
    ]);

    const nested = artifacts[1]!;
    expect(nested.files.map((file) => file.path)).toEqual(['SKILL.md', 'extra.md']);
  });

  it('records a single-file artifact under its basename with parser warnings', async () => {
    await buildDiscoveryFixture(root, outside);
    const { artifacts } = await discoverArtifacts(root);
    const nested = artifacts.find((artifact) => artifact.primaryPath === 'packages/api/AGENTS.md')!;
    expect(nested.parsed.name).toBe('packages/api/AGENTS.md');
    expect(nested.files).toEqual([
      {
        path: 'AGENTS.md',
        sha256: sha256('# API rules\n'),
        size: 12,
        content: '# API rules\n',
      },
    ]);
    expect(nested.contentHash).toBe(hashManifest(nested.files));
    expect(nested.skipped).toEqual([]);

    const copilot = artifacts.find(
      (artifact) => artifact.parsed.format === 'copilot-path-instructions',
    )!;
    expect(copilot.warnings).toEqual([
      'Path-specific instructions without `applyTo` apply to no files',
    ]);
  });

  it('returns identical artifacts, order, hashes and warnings across runs', async () => {
    await buildDiscoveryFixture(root, outside);
    const first = await discoverArtifacts(root);
    const second = await discoverArtifacts(root);
    expect(second).toEqual(first);
  });

  it('never executes, imports or spawns discovered files', async () => {
    await buildDiscoveryFixture(root, outside);
    await discoverArtifacts(root);
    expect(existsSync(join(outside, 'executed.marker'))).toBe(false);
  });

  it('skips .git and node_modules at any depth', async () => {
    expect(SKIPPED_DIRECTORY_NAMES).toEqual(['.git', 'node_modules']);
    await write('.git/AGENTS.md', '# hidden');
    await write('node_modules/pkg/SKILL.md', SKILL);
    await write('skills/x/SKILL.md', SKILL);
    await write('skills/x/node_modules/dep/index.js', 'module.exports = 1;');
    await write('skills/x/.git/config', '[core]');
    const result = await discoverArtifacts(root);
    expect(result.artifacts.map((artifact) => artifact.primaryPath)).toEqual(['skills/x/SKILL.md']);
    expect(result.artifacts[0]!.files.map((file) => file.path)).toEqual(['SKILL.md']);
    expect(result.scannedFiles).toBe(1);
  });
});

describe('discoverArtifacts edge cases', () => {
  it('collects a SKILL.md at the scan root as a skill spanning the tree, with a warning', async () => {
    await write('SKILL.md', SKILL);
    await write('notes.md', 'n');
    await write('sub/SKILL.md', SKILL);
    await write('sub/inner.md', 'i');
    const { artifacts } = await discoverArtifacts(root);

    expect(artifacts.map((artifact) => artifact.occurrencePath)).toEqual(['', 'sub']);
    expect(artifacts[0]!.files.map((file) => file.path)).toEqual(['SKILL.md', 'notes.md']);
    expect(artifacts[0]!.warnings).toContain(
      'SKILL.md is at the scan root: the whole tree is collected as one skill',
    );
    expect(artifacts[1]!.files.map((file) => file.path)).toEqual(['SKILL.md', 'inner.md']);
  });

  it('reports a binary or non-UTF-8 primary file as a discovery error', async () => {
    await write('AGENTS.md', new Uint8Array([0x23, 0x00, 0x41]));
    await write('CLAUDE.md', new Uint8Array([0x23, 0x20, 0xe9, 0x0a]));
    const result = await discoverArtifacts(root);
    expect(result.artifacts).toEqual([]);
    expect(result.errors).toEqual([
      { path: 'AGENTS.md', code: 'binary-primary', message: 'AGENTS.md is not a UTF-8 text file' },
      { path: 'CLAUDE.md', code: 'binary-primary', message: 'CLAUDE.md is not a UTF-8 text file' },
    ]);
  });

  it('only checks the first 8 KiB for NUL bytes', async () => {
    const content = `${'a'.repeat(8 * 1024)}\u0000`;
    await write('AGENTS.md', content);
    const { artifacts, errors } = await discoverArtifacts(root);
    expect(errors).toEqual([]);
    expect(artifacts[0]!.files[0]!.size).toBe(Buffer.byteLength(content));
  });

  it('ignores entries that are neither files, directories nor links', async () => {
    await write('skills/x/SKILL.md', SKILL);
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(join(root, 'skills/x/sock'), resolve));
    try {
      const result = await discoverArtifacts(root);
      expect(result.artifacts[0]!.files.map((file) => file.path)).toEqual(['SKILL.md']);
      expect(result.artifacts[0]!.skipped).toEqual([]);
      expect(result.scannedFiles).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does not follow a symlinked directory', async () => {
    await mkdir(join(outside, 'skills/evil'), { recursive: true });
    await writeFile(join(outside, 'skills/evil/SKILL.md'), SKILL);
    await symlink(join(outside, 'skills'), join(root, 'skills'));
    const result = await discoverArtifacts(root);
    expect(result).toEqual({ artifacts: [], errors: [], scannedFiles: 0 });
  });

  it('scans through a root that is itself a symlink to a directory', async () => {
    await write('real/AGENTS.md', '# Rules\n');
    const link = join(outside, 'root-link');
    await symlink(join(root, 'real'), link);
    const result = await discoverArtifacts(link);
    expect(result.artifacts.map((artifact) => artifact.primaryPath)).toEqual(['AGENTS.md']);
  });

  it('rejects a root that is not a directory or does not exist', async () => {
    await write('file.txt', 'x');
    await expect(discoverArtifacts(join(root, 'file.txt'))).rejects.toThrow(
      `Discovery root is not a directory: ${join(root, 'file.txt')}`,
    );
    await expect(discoverArtifacts(join(root, 'missing'))).rejects.toThrow(/ENOENT/);
  });
});

describe('discoverArtifacts cancellation', () => {
  it('throws the abort reason before walking when the signal is already aborted', async () => {
    await write('AGENTS.md', '# Rules\n');
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    await expect(discoverArtifacts(root, { signal: controller.signal })).rejects.toThrow(
      'shutdown',
    );
  });

  it('checks the signal before each directory and each candidate', async () => {
    await write('AGENTS.md', '# Rules\n');
    await write('sub/CLAUDE.md', '# Rules\n');
    let checks = 0;
    // Two directories are listed (root, sub); the third check is the first candidate.
    const signal = {
      throwIfAborted: () => {
        checks += 1;
        if (checks === 3) throw new Error('cancelled');
      },
    } as AbortSignal;
    await expect(discoverArtifacts(root, { signal })).rejects.toThrow('cancelled');
    expect(checks).toBe(3);
  });

  it('completes normally with a signal that is never aborted', async () => {
    await write('AGENTS.md', '# Rules\n');
    const result = await discoverArtifacts(root, { signal: new AbortController().signal });
    expect(result.artifacts).toHaveLength(1);
  });
});

describe('discoverArtifacts limits', () => {
  it('uses the SPEC-102 FR-102-16 defaults', () => {
    expect(DISCOVERY_LIMITS).toEqual({
      maxPrimaryFileBytes: 1024 * 1024,
      maxSupportingFileBytes: 5 * 1024 * 1024,
      maxArtifactBytes: 20 * 1024 * 1024,
      maxFilesPerArtifact: 500,
      maxCandidatesPerScan: 10_000,
    });
  });

  it('reports an oversized primary file for that artifact only', async () => {
    await write('AGENTS.md', '# Rules that are too long\n');
    await write('CLAUDE.md', '# ok\n');
    const result = await discoverArtifacts(root, { limits: { maxPrimaryFileBytes: 10 } });
    expect(result.artifacts.map((artifact) => artifact.primaryPath)).toEqual(['CLAUDE.md']);
    expect(result.errors).toEqual([
      {
        path: 'AGENTS.md',
        code: 'too-large',
        message: 'AGENTS.md is 26 bytes, larger than the limit of 10 bytes',
      },
    ]);
  });

  it('reports an oversized supporting file as an error for its skill', async () => {
    await write('skills/x/SKILL.md', SKILL);
    await write('skills/x/big.md', 'x'.repeat(11));
    const result = await discoverArtifacts(root, { limits: { maxSupportingFileBytes: 10 } });
    expect(result.artifacts).toEqual([]);
    expect(result.errors).toEqual([
      {
        path: 'skills/x/SKILL.md',
        code: 'too-large',
        message: 'skills/x/big.md is 11 bytes, larger than the limit of 10 bytes',
      },
    ]);
  });

  it('reports a skill larger than the total size limit', async () => {
    await write('skills/x/SKILL.md', SKILL);
    await write('skills/x/a.md', 'a');
    const limit = Buffer.byteLength(SKILL);
    const result = await discoverArtifacts(root, { limits: { maxArtifactBytes: limit } });
    expect(result.errors).toEqual([
      {
        path: 'skills/x/SKILL.md',
        code: 'too-large',
        message: `Skill skills/x/SKILL.md is larger than the limit of ${limit} bytes`,
      },
    ]);
  });

  it('reports a skill with too many files without reading them', async () => {
    await write('skills/x/SKILL.md', SKILL);
    await write('skills/x/a.md', 'a');
    await write('skills/x/b.md', 'b');
    await write('skills/y/SKILL.md', SKILL);
    const result = await discoverArtifacts(root, { limits: { maxFilesPerArtifact: 2 } });
    expect(result.artifacts.map((artifact) => artifact.primaryPath)).toEqual(['skills/y/SKILL.md']);
    expect(result.errors).toEqual([
      {
        path: 'skills/x/SKILL.md',
        code: 'too-many-files',
        message: 'Skill skills/x/SKILL.md has 3 files, more than the limit of 2',
      },
    ]);
  });

  it('aborts the scan when there are more candidates than the per-scan limit', async () => {
    await write('AGENTS.md', '# a');
    await write('CLAUDE.md', '# c');
    await expect(discoverArtifacts(root, { limits: { maxCandidatesPerScan: 1 } })).rejects.toThrow(
      'Discovery aborted: 2 candidate artifacts exceed the limit of 1 per scan',
    );
  });
});
