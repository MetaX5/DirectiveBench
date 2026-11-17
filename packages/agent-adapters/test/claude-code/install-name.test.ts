import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  baselineSkillNameIssue,
  claudeArtifactProfile,
  ClaudeCodeError,
  claudeSkillInstall,
} from '../../src/claude-code';
import { MockAgentAdapter, mockSkillDirectory } from '../../src/mock';
import { pinWorkspace } from '../../src/workspace-pin';
import { bundle, installPinned } from './helpers';

// Issue 245 (SPEC-203 §4.1): a skill without a frontmatter `name` is installed in, and named
// after, the folder its repository's own agent sees (`ArtifactBundle.folderName`), not the slug.

let scratch: string;
let workspace: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'db-claude-install-name-'));
  workspace = join(scratch, 'workspace');
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const NAMELESS = '---\ndescription: Reviews code\n---\nReview the diff.\n';

/** A nameless skill whose artifact got slug `slug` and now lives in folder `folderName`. */
function nameless(slug: string, folderName: string | null | undefined, versionId = 'ver_1') {
  return bundle(
    'skill-md',
    { 'SKILL.md': NAMELESS },
    { slug, name: folderName ?? slug, versionId, folderName },
  );
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ClaudeCodeError
      ? error.code
      : `not a ClaudeCodeError: ${String(error)}`;
  }
  return undefined;
}

describe('the install name of a skill without a frontmatter name (issue 245)', () => {
  it('installs a renamed nameless skill under its new folder, not under the slug', async () => {
    const renamed = nameless('review', 'code-review');
    expect(claudeSkillInstall(renamed)).toEqual({ name: 'code-review', directory: 'code-review' });
    expect(claudeArtifactProfile(renamed)).toEqual({
      format: 'skill-md',
      skillName: 'code-review',
    });
    expect(await installPinned(workspace, renamed)).toEqual({
      paths: ['.claude/skills/code-review/SKILL.md'],
    });
    expect(await readdir(join(workspace, '.claude/skills'))).toEqual(['code-review']);
  });

  it('installs a nameless skill in folder review whose slug got a suffix as review', async () => {
    const suffixed = nameless('review-2', 'review');
    expect(claudeSkillInstall(suffixed)).toEqual({ name: 'review', directory: 'review' });
    expect(await installPinned(workspace, suffixed)).toEqual({
      paths: ['.claude/skills/review/SKILL.md'],
    });
  });

  it('refuses an invalid folder name with skill-name-unsupported, never falling back to the slug', async () => {
    for (const folder of ['Review_Tool', 'my skill', 'a'.repeat(65), '..']) {
      expect(codeOf(() => claudeSkillInstall(nameless('review-tool', folder)))).toBe(
        'skill-name-unsupported',
      );
    }
    await expect(installPinned(workspace, nameless('review-tool', 'Review_Tool'))).rejects.toThrow(
      'is not supported',
    );
    expect(await readdir(workspace)).toEqual([]);
  });

  it('keeps the slug directory and the frontmatter name for a skill that declares a name', async () => {
    const named = bundle(
      'skill-md',
      { 'SKILL.md': '---\nname: pdf-report\n---\nFill PDFs.\n' },
      { slug: 'pdf', folderName: 'Some_Folder' },
    );
    expect(claudeSkillInstall(named)).toEqual({ name: 'pdf-report', directory: 'pdf' });
    expect(await installPinned(workspace, named)).toEqual({
      paths: ['.claude/skills/pdf/SKILL.md'],
    });
  });

  it('uses the slug when no folder is known (null or absent folderName)', () => {
    expect(claudeSkillInstall(nameless('review', null))).toEqual({
      name: 'review',
      directory: 'review',
    });
    expect(claudeSkillInstall(nameless('review', undefined)).name).toBe('review');
  });

  it('lets an A/B run compare two nameless versions created in different folders', () => {
    // The folder comes from the artifact's representative occurrence, so both versions of one
    // artifact carry the same folderName (SPEC-118 FR-118-08).
    const v1 = nameless('review', 'code-review', 'ver_1');
    const v2 = bundle(
      'skill-md',
      { 'SKILL.md': `${NAMELESS}More.\n` },
      { slug: 'review', versionId: 'ver_2', folderName: 'code-review' },
    );
    expect(baselineSkillNameIssue(v2, v1)).toBeNull();
    const named = bundle(
      'skill-md',
      { 'SKILL.md': '---\nname: review\n---\nx\n' },
      { slug: 'review', versionId: 'ver_3', folderName: 'code-review' },
    );
    expect(baselineSkillNameIssue(named, v1)).toContain('differs');
  });

  it('never installs two skills in one workspace: a second install fails closed', async () => {
    await installPinned(workspace, nameless('review', 'review'));
    await expect(installPinned(workspace, nameless('lint', 'lint'))).rejects.toMatchObject({
      code: 'artifact-install-conflict',
    });
    expect(await readdir(join(workspace, '.claude/skills'))).toEqual(['review']);
  });
});

describe('the mock agent follows the same rule (SPEC-107 §8, issue 245)', () => {
  const mock = new MockAgentAdapter();

  it('installs a nameless skill under its folder and a named one under the slug', async () => {
    expect(mockSkillDirectory(nameless('review-2', 'review'))).toBe('review');
    expect(mockSkillDirectory(nameless('review', null))).toBe('review');
    const named = bundle(
      'skill-md',
      { 'SKILL.md': '---\nname: pdf-report\n---\nx\n' },
      { slug: 'pdf', folderName: 'pdf-folder' },
    );
    expect(mockSkillDirectory(named)).toBe('pdf');
    // A bundle without SKILL.md declares no name.
    expect(mockSkillDirectory(bundle('skill-md', { 'README.md': 'x' }, { folderName: 'x' }))).toBe(
      'x',
    );
    // Unparsable frontmatter declares no name either, as when core names the artifact.
    expect(
      mockSkillDirectory(
        bundle('skill-md', { 'SKILL.md': '---\nname: [\n---\nx\n' }, { folderName: 'f' }),
      ),
    ).toBe('f');

    expect(
      await mock.installArtifact(await pinWorkspace(workspace), nameless('review', 'code-review')),
    ).toEqual({ paths: ['.agents/skills/code-review/SKILL.md'] });
  });
});
