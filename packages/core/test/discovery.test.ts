import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISCOVERY_LIMITS,
  discoverArtifacts,
  DiscoveryLimitError,
  DiscoveryRootChangedError,
  SKIPPED_DIRECTORY_NAMES,
} from '../src/discovery';
import { parseFrontmatter } from '../src/frontmatter';
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
    expect(result).toEqual({ artifacts: [], errors: [], scannedFiles: 0, skippedDirectories: [] });
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

describe('discoverArtifacts skipDirectories (user-level folders, D05)', () => {
  it('never enters a skipped directory and reports where it skipped', async () => {
    await write('home/AGENTS.md', '# Home rules\n');
    await write('home/.claude/skills/global/SKILL.md', SKILL);
    await write('home/.claude/CLAUDE.md', '# User-level\n');
    await write('home/project/.claude/skills/local/SKILL.md', SKILL);
    const realRoot = await realpath(root);
    const result = await discoverArtifacts(realRoot, {
      skipDirectories: [join(realRoot, 'home/.claude'), join(realRoot, 'home/.codex')],
    });
    expect(result.artifacts.map((artifact) => artifact.primaryPath)).toEqual([
      'home/AGENTS.md',
      'home/project/.claude/skills/local/SKILL.md',
    ]);
    expect(result.errors).toEqual([]);
    expect(result.scannedFiles).toBe(2);
    expect(result.skippedDirectories).toEqual(['home/.claude']);
  });

  it('reads nothing when the root is a skipped directory or lies inside one', async () => {
    await write('home/.claude/skills/global/SKILL.md', SKILL);
    const realRoot = await realpath(root);
    const skipDirectories = [join(realRoot, 'home/.claude')];
    const empty = { artifacts: [], errors: [], scannedFiles: 0, skippedDirectories: ['.'] };
    expect(await discoverArtifacts(join(realRoot, 'home/.claude'), { skipDirectories })).toEqual(
      empty,
    );
    expect(
      await discoverArtifacts(join(realRoot, 'home/.claude/skills'), { skipDirectories }),
    ).toEqual(empty);
  });
});

describe('discoverArtifacts robustness', () => {
  it('reports an unreadable subdirectory as an error and scans the rest', async () => {
    await write('AGENTS.md', '# Rules\n');
    await write('locked/CLAUDE.md', '# Hidden\n');
    await write('z/CLAUDE.md', '# Visible\n');
    await chmod(join(root, 'locked'), 0o000);
    try {
      const result = await discoverArtifacts(root);
      expect(result.artifacts.map((artifact) => artifact.primaryPath)).toEqual([
        'AGENTS.md',
        'z/CLAUDE.md',
      ]);
      expect(result.errors).toEqual([
        {
          path: 'locked',
          code: 'read-failed',
          message: 'Cannot read directory locked (EACCES); its files were not scanned',
        },
      ]);
    } finally {
      await chmod(join(root, 'locked'), 0o755);
    }
  });

  it('reports a skill with an unreadable directory inside it as an error, not a partial artifact', async () => {
    await write('skills/x/SKILL.md', SKILL);
    await write('skills/x/notes.md', '# Notes\n');
    await write('skills/x/references/a/api.md', '# API\n');
    await write('skills/x/references/b/cli.md', '# CLI\n');
    await write('skills/y/SKILL.md', SKILL);
    await chmod(join(root, 'skills/x/references/b'), 0o000);
    await chmod(join(root, 'skills/x/references/a'), 0o000);
    try {
      const result = await discoverArtifacts(root);
      // The readable rest of x (SKILL.md, notes.md) is not returned as a smaller version of x.
      expect(result.artifacts.map((artifact) => artifact.primaryPath)).toEqual([
        'skills/y/SKILL.md',
      ]);
      // One error for the skill, naming the first unreadable directory by path.
      expect(result.errors).toEqual([
        {
          path: 'skills/x/SKILL.md',
          code: 'read-failed',
          message:
            'Skill skills/x/SKILL.md is incomplete and was not discovered. Cannot read directory skills/x/references/a (EACCES); its files were not scanned (and 1 more directory)',
        },
      ]);
    } finally {
      await chmod(join(root, 'skills/x/references/a'), 0o755);
      await chmod(join(root, 'skills/x/references/b'), 0o755);
    }
  });

  it('charges an unreadable directory to the deepest skill containing it only', async () => {
    await write('skills/outer/SKILL.md', SKILL);
    await write('skills/outer/inner/SKILL.md', SKILL);
    await write('skills/outer/inner/locked/a.md', 'a');
    await write('SKILL.md', SKILL);
    const rootLocked = ['other/locked', 'other/locked-2', 'other/locked-3'];
    for (const dir of rootLocked) await write(`${dir}/b.md`, 'b');
    // With a root SKILL.md, every directory outside a deeper skill belongs to the root skill.
    await chmod(join(root, 'skills/outer/inner/locked'), 0o000);
    for (const dir of rootLocked) await chmod(join(root, dir), 0o000);
    try {
      const result = await discoverArtifacts(root);
      expect(result.artifacts.map((artifact) => artifact.primaryPath)).toEqual([
        'skills/outer/SKILL.md',
      ]);
      expect(result.errors.map((error) => [error.path, error.code])).toEqual([
        ['SKILL.md', 'read-failed'],
        ['skills/outer/inner/SKILL.md', 'read-failed'],
      ]);
      // The first unreadable directory by path is named; the others are counted.
      expect(result.errors[0]?.message).toBe(
        'Skill SKILL.md is incomplete and was not discovered. Cannot read directory other/locked (EACCES); its files were not scanned (and 2 more directories)',
      );
    } finally {
      await chmod(join(root, 'skills/outer/inner/locked'), 0o755);
      for (const dir of rootLocked) await chmod(join(root, dir), 0o755);
    }
  });

  it('keeps an unreadable directory that may hold skills as an error of its own', async () => {
    await write('.agents/skills/pdf/SKILL.md', SKILL);
    await write('AGENTS.md', '# Rules\n');
    await chmod(join(root, '.agents/skills'), 0o000);
    try {
      const result = await discoverArtifacts(root);
      expect(result.artifacts.map((artifact) => artifact.primaryPath)).toEqual(['AGENTS.md']);
      expect(result.errors).toEqual([
        {
          path: '.agents/skills',
          code: 'read-failed',
          message: 'Cannot read directory .agents/skills (EACCES); its files were not scanned',
        },
      ]);
    } finally {
      await chmod(join(root, '.agents/skills'), 0o755);
    }
  });

  it('sorts directory and artifact errors together by path', async () => {
    await write('a/AGENTS.md', '\0binary');
    await write('b/CLAUDE.md', '# Hidden\n');
    await write('c/AGENTS.md', '\0binary');
    await chmod(join(root, 'b'), 0o000);
    try {
      const result = await discoverArtifacts(root);
      expect(result.errors.map((error) => [error.path, error.code])).toEqual([
        ['a/AGENTS.md', 'binary-primary'],
        ['b', 'read-failed'],
        ['c/AGENTS.md', 'binary-primary'],
      ]);
    } finally {
      await chmod(join(root, 'b'), 0o755);
    }
  });

  it('rethrows when the root itself cannot be listed', async () => {
    await chmod(root, 0o000);
    try {
      await expect(discoverArtifacts(root)).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(root, 0o755);
    }
  });

  it('reads nothing when the root no longer resolves to the expected location', async () => {
    await write('AGENTS.md', '# Rules\n');
    const canonical = await realpath(root);
    expect((await discoverArtifacts(root, { expectedRoot: canonical })).artifacts).toHaveLength(1);
    const link = join(outside, 'swapped');
    await symlink(root, link);
    await expect(discoverArtifacts(link, { expectedRoot: link })).rejects.toThrow(
      DiscoveryRootChangedError,
    );
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
      maxScanBytes: 256 * 1024 * 1024,
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
    const aborted = discoverArtifacts(root, { limits: { maxCandidatesPerScan: 1 } });
    await expect(aborted).rejects.toThrow(
      'Discovery aborted: 2 candidate artifacts exceed the limit of 1 per scan',
    );
    await expect(aborted).rejects.toMatchObject({
      name: 'DiscoveryLimitError',
      limit: 'maxCandidatesPerScan',
    });
  });

  it('aborts the scan once the kept content would exceed the per-scan byte limit', async () => {
    await write('AGENTS.md', '# a\n'); // 4 bytes, and `{}` (2 bytes) as its frontmatter JSON
    await write('b/AGENTS.md', '\0binary'); // an error: not kept, not counted
    await write('skills/x/SKILL.md', SKILL);
    await write('skills/x/notes.md', '12345'); // 5 bytes
    const agentsBytes = 4 + 2;
    const skillFileBytes = Buffer.byteLength(SKILL) + 5;
    const skillBytes =
      skillFileBytes + Buffer.byteLength(JSON.stringify(parseFrontmatter(SKILL).frontmatter));
    const all = await discoverArtifacts(root, {
      limits: { maxScanBytes: agentsBytes + skillBytes },
    });
    expect(all.artifacts.map((artifact) => artifact.primaryPath)).toEqual([
      'AGENTS.md',
      'skills/x/SKILL.md',
    ]);
    expect(all.errors.map((error) => error.path)).toEqual(['b/AGENTS.md']);

    // One byte less: the skill's frontmatter JSON would cross the limit, so the scan is aborted.
    const aborted = discoverArtifacts(root, {
      limits: { maxScanBytes: agentsBytes + skillBytes - 1 },
    });
    await expect(aborted).rejects.toThrow(DiscoveryLimitError);
    await expect(aborted).rejects.toMatchObject({
      limit: 'maxScanBytes',
      message: `Discovery aborted: the discovered artifacts exceed the limit of ${agentsBytes + skillBytes - 1} bytes per scan`,
    });
    // Less still: the skill's last file would cross it, before the rest of the skill is read.
    await expect(
      discoverArtifacts(root, { limits: { maxScanBytes: agentsBytes + skillFileBytes - 1 } }),
    ).rejects.toMatchObject({ limit: 'maxScanBytes' });
    // A single-file artifact is checked before it is kept, too.
    await expect(discoverArtifacts(root, { limits: { maxScanBytes: 3 } })).rejects.toMatchObject({
      limit: 'maxScanBytes',
    });
  });

  // Regression (review of PR #44 at 2d668f3): the frontmatter is stored as JSON with its aliases
  // expanded, so a small file can store far more than its own size. The per-file cap
  // (MAX_FRONTMATTER_JSON_BYTES) bounds one file; the scan limit must count the expansion too.
  it('counts the expanded frontmatter JSON, not only the file, against the per-scan limit', async () => {
    const long = 'x'.repeat(1000);
    const skill = `---\nname: wide\ndescription: d\na: &a "${long}"\nb: [${Array(50).fill('*a').join(', ')}]\n---\n# Wide\n`;
    await write('skills/wide/SKILL.md', skill);
    expect(Buffer.byteLength(skill)).toBeLessThan(2_000);
    const aborted = discoverArtifacts(root, { limits: { maxScanBytes: 10_000 } });
    await expect(aborted).rejects.toMatchObject({
      name: 'DiscoveryLimitError',
      limit: 'maxScanBytes',
    });
    const allowed = await discoverArtifacts(root, { limits: { maxScanBytes: 60_000 } });
    expect(allowed.artifacts[0]?.parsed.frontmatter.b).toHaveLength(50);
  });
});
