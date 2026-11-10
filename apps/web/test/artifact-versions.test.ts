import { describe, expect, it, vi } from 'vitest';
import { copyStatusMessage, copyText, firstSeenLabel, shortHash } from '../lib/artifact-versions';

const hash = '3f2a9c1d0e4b5a6978877665544332211ffeeddccbbaa99887766554433221100';
const repositories = [
  { id: 'repo_a', name: 'acme/agent-rules' },
  { id: 'repo_b', name: 'versions-team' },
];

describe('shortHash', () => {
  it('shows the first 16 characters and marks the cut', () => {
    expect(shortHash(hash)).toBe('3f2a9c1d0e4b5a69…');
  });
});

describe('firstSeenLabel (SPEC-103 §11, FR-103-15)', () => {
  it('names the repository, the path and the short commit', () => {
    expect(
      firstSeenLabel(
        {
          sourceRepositoryId: 'repo_a',
          sourcePath: '.claude/skills/review',
          sourceCommitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        },
        repositories,
      ),
    ).toBe('acme/agent-rules:.claude/skills/review@abcdef0');
  });

  it('leaves the commit out for a working-tree scan', () => {
    expect(
      firstSeenLabel(
        { sourceRepositoryId: 'repo_b', sourcePath: 'AGENTS.md', sourceCommitSha: null },
        repositories,
      ),
    ).toBe('versions-team:AGENTS.md');
  });

  it('says the repository is unknown when it is gone, and leaves out a missing path', () => {
    expect(
      firstSeenLabel(
        { sourceRepositoryId: null, sourcePath: null, sourceCommitSha: null },
        repositories,
      ),
    ).toBe('Unknown repository');
    expect(
      firstSeenLabel(
        { sourceRepositoryId: 'repo_gone', sourcePath: 'x', sourceCommitSha: null },
        repositories,
      ),
    ).toBe('Unknown repository:x');
  });
});

describe('copyText', () => {
  it('writes the text and reports success', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    expect(await copyText({ writeText }, hash)).toBe('copied');
    expect(writeText).toHaveBeenCalledWith(hash);
  });

  it('fails without a clipboard (an insecure context) and when the browser refuses', async () => {
    expect(await copyText(undefined, hash)).toBe('failed');
    const writeText = vi.fn(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    expect(await copyText({ writeText }, hash)).toBe('failed');
  });
});

describe('copyStatusMessage', () => {
  it('confirms a copy and shows the full hash when the copy failed', () => {
    expect(copyStatusMessage('copied', hash)).toBe('Copied.');
    expect(copyStatusMessage('failed', hash)).toBe(
      `Not copied: the browser blocked the clipboard. Full hash: ${hash}`,
    );
  });
});
