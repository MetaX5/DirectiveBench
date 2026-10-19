import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARTIFACT_LIMITS, loadLocalArtifact } from '../src/artifact-loader';
import { BINARY_SNIFF_BYTES } from '../src/discovery';
import { hashManifest, sha256 } from '../src/hash';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'db-artifact-loader-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string | Uint8Array): Promise<void> {
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

const SKILL = '---\nname: PDF Tools\ndescription: Work with PDFs.\n---\n# PDF\n';

describe('loadLocalArtifact', () => {
  it('loads a skill directory with its supporting files in a stable order', async () => {
    await write('.claude/skills/pdf/SKILL.md', SKILL);
    await write('.claude/skills/pdf/scripts/run.sh', 'echo hi\n');
    await write('.claude/skills/pdf/references/b.md', 'b');
    await write('.claude/skills/pdf/references/a.md', 'a');

    const loaded = await loadLocalArtifact(root, '.claude/skills/pdf/SKILL.md');

    expect(loaded.slug).toBe('pdf-tools');
    expect(loaded.parsed.name).toBe('PDF Tools');
    expect(loaded.path).toBe('.claude/skills/pdf');
    expect(loaded.primaryFile).toBe('SKILL.md');
    expect(loaded.warnings).toEqual([]);
    expect(loaded.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/a.md',
      'references/b.md',
      'scripts/run.sh',
    ]);
    expect(loaded.files.find((file) => file.path === 'scripts/run.sh')).toEqual({
      path: 'scripts/run.sh',
      sha256: sha256('echo hi\n'),
      size: 8,
      content: 'echo hi\n',
    });
    expect(loaded.contentHash).toBe(hashManifest(loaded.files));
  });

  it('produces the same content hash for identical skill directories', async () => {
    await write('a/skills/x/SKILL.md', SKILL);
    await write('a/skills/x/ref.md', 'same');
    await write('b/skills/x/ref.md', 'same');
    await write('b/skills/x/SKILL.md', SKILL);
    const first = await loadLocalArtifact(join(root, 'a'), 'skills/x/SKILL.md');
    const second = await loadLocalArtifact(join(root, 'b'), 'skills/x/SKILL.md');
    expect(first.contentHash).toBe(second.contentHash);

    await write('b/skills/x/ref.md', 'changed');
    const changed = await loadLocalArtifact(join(root, 'b'), 'skills/x/SKILL.md');
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it('treats the whole source root as the skill directory for a root SKILL.md', async () => {
    await write('SKILL.md', SKILL);
    await write('notes.md', 'n');
    const loaded = await loadLocalArtifact(root, 'SKILL.md');
    expect(loaded.path).toBe('');
    expect(loaded.primaryFile).toBe('SKILL.md');
    expect(loaded.files.map((file) => file.path)).toEqual(['SKILL.md', 'notes.md']);
  });

  it('skips symbolic links, binary files, .git and node_modules with warnings', async () => {
    await write('skills/x/SKILL.md', SKILL);
    await write('skills/x/image.png', new Uint8Array([0x89, 0x50, 0x00, 0x47]));
    await write('skills/x/.git/config', '[core]');
    await write('skills/x/node_modules/dep/index.js', 'module.exports = 1;');
    await write('outside.txt', 'secret');
    await symlink(join(root, 'outside.txt'), join(root, 'skills/x/link.txt'));

    const loaded = await loadLocalArtifact(root, 'skills/x/SKILL.md');

    expect(loaded.files.map((file) => file.path)).toEqual(['SKILL.md']);
    expect(loaded.warnings).toEqual([
      'Skipped binary file image.png',
      'Skipped symbolic link link.txt',
    ]);
  });

  it('skips non-UTF-8 supporting files so stored content re-encodes to the source bytes', async () => {
    await write('skills/x/SKILL.md', SKILL);
    // Latin-1 "café": no NUL byte, but not valid UTF-8 (SPEC-102 FR-102-17).
    await write('skills/x/latin1.txt', new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await write('skills/x/bom-crlf.md', '\uFEFFZażółć\r\n');
    // Only the first BINARY_SNIFF_BYTES are checked for NUL, as in the repository walker.
    await write('skills/x/late-nul.txt', `${'a'.repeat(BINARY_SNIFF_BYTES)}\0`);

    const loaded = await loadLocalArtifact(root, 'skills/x/SKILL.md');

    expect(loaded.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'bom-crlf.md',
      'late-nul.txt',
    ]);
    expect(loaded.warnings).toEqual(['Skipped binary file latin1.txt']);
    // What importArtifactVersion recomputes from content equals the hash of the raw bytes.
    for (const file of loaded.files) {
      const bytes = Buffer.from(file.content, 'utf8');
      expect(sha256(bytes)).toBe(file.sha256);
      expect(bytes.length).toBe(file.size);
    }
  });

  it('rejects a primary file that is not UTF-8 text', async () => {
    await write('skills/x/SKILL.md', new Uint8Array([0x23, 0x20, 0xe9, 0x0a]));
    await expect(loadLocalArtifact(root, 'skills/x/SKILL.md')).rejects.toThrow(
      'Artifact file is not a UTF-8 text file: skills/x/SKILL.md',
    );
    await write('AGENTS.md', new Uint8Array([0x23, 0x00, 0x0a]));
    await expect(loadLocalArtifact(root, 'AGENTS.md')).rejects.toThrow(
      'Artifact file is not a UTF-8 text file: AGENTS.md',
    );
  });

  it('ignores entries that are neither files, directories nor links', async () => {
    await write('skills/x/SKILL.md', SKILL);
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(join(root, 'skills/x/sock'), resolve));
    try {
      const loaded = await loadLocalArtifact(root, 'skills/x/SKILL.md');
      expect(loaded.files.map((file) => file.path)).toEqual(['SKILL.md']);
      expect(loaded.warnings).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keeps parser warnings for skills without metadata', async () => {
    await write('skills/bare/SKILL.md', 'no frontmatter');
    const loaded = await loadLocalArtifact(root, 'skills/bare/SKILL.md');
    expect(loaded.slug).toBe('bare');
    expect(loaded.warnings).toHaveLength(2);
  });

  it('rejects skills with too many files', async () => {
    await write('skills/x/SKILL.md', SKILL);
    await Promise.all(
      Array.from({ length: ARTIFACT_LIMITS.maxFiles }, (_, index) =>
        write(`skills/x/files/${String(index).padStart(3, '0')}.md`, 'x'),
      ),
    );
    await expect(loadLocalArtifact(root, 'skills/x/SKILL.md')).rejects.toThrow(
      /Artifact exceeds limits/,
    );
  });

  it('rejects skills larger than the total size limit', async () => {
    await write('skills/x/SKILL.md', SKILL);
    await write('skills/x/big.md', 'x'.repeat(ARTIFACT_LIMITS.maxTotalBytes));
    await expect(loadLocalArtifact(root, 'skills/x/SKILL.md')).rejects.toThrow(
      /Artifact exceeds limits/,
    );
  });

  it('loads a single-file artifact without reading its siblings', async () => {
    const content = '# Repository rules\nBe careful.\n';
    await write('packages/api/AGENTS.md', content);
    await write('packages/api/other.md', 'not part of the artifact');

    const loaded = await loadLocalArtifact(root, 'packages/api/AGENTS.md');

    expect(loaded.slug).toBe('packages-api-agents-md');
    expect(loaded.path).toBe('packages/api/AGENTS.md');
    expect(loaded.primaryFile).toBe('AGENTS.md');
    expect(loaded.files).toEqual([
      { path: 'AGENTS.md', sha256: sha256(content), size: Buffer.byteLength(content), content },
    ]);
    expect(loaded.contentHash).toBe(hashManifest(loaded.files));
  });

  it('rejects paths that are not artifacts', async () => {
    await write('README.md', '# Readme');
    await expect(loadLocalArtifact(root, 'README.md')).rejects.toThrow(
      'Not a recognised artifact path: README.md',
    );
  });

  it('rejects a primary file that is not a regular file', async () => {
    await write('real/AGENTS.md', '# Rules');
    await symlink(join(root, 'real/AGENTS.md'), join(root, 'AGENTS.md'));
    await expect(loadLocalArtifact(root, 'AGENTS.md')).rejects.toThrow(
      'Artifact file is not a regular file: AGENTS.md',
    );
    await mkdir(join(root, 'skills/dir/SKILL.md'), { recursive: true });
    await expect(loadLocalArtifact(root, 'skills/dir/SKILL.md')).rejects.toThrow(
      /not a regular file/,
    );
  });
});
