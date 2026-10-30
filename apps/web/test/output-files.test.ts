import { describe, expect, it } from 'vitest';
import {
  displayLines,
  fileBadges,
  fileNotices,
  formatBytes,
  formatSize,
  onlyInBadge,
  syntaxHighlightNotice,
  type OutputFile,
} from '../lib/output-files';
import type { HighlightResult } from '../lib/syntax-highlight';

const file = (overrides: Partial<OutputFile> = {}): OutputFile => ({
  path: 'src/render.php',
  change: 'modified',
  sizeBytes: 2184,
  kept: 'full',
  reason: null,
  content: '<?php\necho 1;\n',
  redactions: 0,
  ...overrides,
});

describe('fileBadges', () => {
  it('names the change as an outline badge', () => {
    expect(fileBadges(file({ change: 'added' }))).toEqual([{ label: 'Added', variant: 'outline' }]);
    expect(fileBadges(file())).toEqual([{ label: 'Modified', variant: 'outline' }]);
  });

  it('adds no second badge to a deleted file', () => {
    expect(fileBadges(file({ change: 'deleted', kept: 'none', reason: 'deleted' }))).toEqual([
      { label: 'Deleted', variant: 'outline' },
    ]);
  });

  it('marks truncated files as a warning', () => {
    expect(fileBadges(file({ kept: 'truncated', reason: 'file-limit' }))).toEqual([
      { label: 'Modified', variant: 'outline' },
      { label: 'Truncated', variant: 'warning' },
    ]);
  });

  it('says why a file was not kept', () => {
    const second = (overrides: Partial<OutputFile>) =>
      fileBadges(file({ kept: 'none', content: null, ...overrides }))[1];
    expect(second({ reason: 'binary' })).toEqual({ label: 'Binary, not kept', variant: 'muted' });
    expect(second({ reason: 'artifact-path' })).toEqual({
      label: 'Artifact file',
      variant: 'muted',
    });
    expect(second({ reason: 'run-limit' })).toEqual({ label: 'Not kept', variant: 'muted' });
    expect(second({ reason: 'file-limit' })).toEqual({ label: 'Not kept', variant: 'muted' });
    expect(second({ reason: 'deleted' })).toEqual({ label: 'Not kept', variant: 'muted' });
    expect(second({ reason: null })).toEqual({ label: 'Not kept', variant: 'muted' });
  });

  it('counts redactions', () => {
    expect(fileBadges(file({ redactions: 2 }))[1]).toEqual({
      label: '2 redacted',
      variant: 'info',
    });
  });
});

describe('onlyInBadge', () => {
  it('names the side the path exists on', () => {
    expect(onlyInBadge('right')).toEqual({ label: 'Only right', variant: 'outline' });
    expect(onlyInBadge('A')).toEqual({ label: 'Only A', variant: 'outline' });
  });
});

describe('formatBytes and formatSize', () => {
  it('formats exact byte counts', () => {
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1_572_864)).toBe('1,572,864 bytes');
  });

  it('shortens sizes from 1 KB', () => {
    expect(formatSize(1023)).toBe('1,023 bytes');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(2184)).toBe('2.1 KB');
    expect(formatSize(1_048_576)).toBe('1.0 MB');
  });
});

describe('fileNotices', () => {
  it('says nothing about a file kept in full', () => {
    expect(fileNotices(file())).toEqual([]);
  });

  it('says a file is empty', () => {
    expect(fileNotices(file({ content: '', sizeBytes: 0 }))).toEqual(['The file is empty.']);
  });

  it('explains truncation by either limit', () => {
    expect(
      fileNotices(file({ kept: 'truncated', reason: 'file-limit', sizeBytes: 1_572_864 })),
    ).toEqual(['Truncated at 1 MB: the file has 1,572,864 bytes.']);
    expect(fileNotices(file({ kept: 'truncated', reason: 'run-limit' }))).toEqual([
      'Truncated: the 10 MB limit for this agent run was reached.',
    ]);
    expect(fileNotices(file({ kept: 'truncated', reason: 'file-limit', sizeBytes: null }))).toEqual(
      ['Truncated at 1 MB: the file has 0 bytes.'],
    );
  });

  it('explains every reason a file was not kept', () => {
    const notice = (overrides: Partial<OutputFile>) =>
      fileNotices(file({ kept: 'none', content: null, ...overrides }));
    expect(notice({ change: 'deleted', reason: 'deleted', sizeBytes: null })).toEqual([
      'Deleted by the agent.',
    ]);
    expect(notice({ reason: 'binary' })).toEqual(['Binary file, not kept.']);
    expect(notice({ reason: 'artifact-path' })).toEqual(['Artifact file, not kept.']);
    expect(notice({ reason: 'run-limit' })).toEqual([
      'Not kept: the 10 MB limit for this agent run was reached.',
    ]);
  });

  it('counts redacted secrets', () => {
    expect(fileNotices(file({ redactions: 1 }))).toEqual(['1 secret redacted.']);
    expect(fileNotices(file({ redactions: 3 }))).toEqual(['3 secrets redacted.']);
  });

  it('says when carriage returns are shown as line feeds', () => {
    expect(fileNotices(file({ content: 'a\r\nb\r\n' }))).toEqual(['Shown with LF line endings.']);
  });
});

describe('displayLines', () => {
  it('splits text into lines without a trailing empty line', () => {
    expect(displayLines('')).toEqual([]);
    expect(displayLines('\n')).toEqual(['']);
    expect(displayLines('a\nb')).toEqual(['a', 'b']);
    expect(displayLines('a\nb\n')).toEqual(['a', 'b']);
    expect(displayLines('a\n\nb\n\n')).toEqual(['a', '', 'b', '']);
  });

  it('treats CR LF and lone CR as line breaks', () => {
    expect(displayLines('a\r\nb\rc\r\n')).toEqual(['a', 'b', 'c']);
  });
});

describe('syntaxHighlightNotice (SPEC-123 FR-123-74, FR-123-78)', () => {
  it.each<[HighlightResult | undefined, string | null]>([
    [undefined, null],
    [{ kind: 'highlighted', lines: [] }, null],
    [{ kind: 'plain', reason: 'no-language' }, null],
    [{ kind: 'plain', reason: 'too-large' }, 'Syntax highlighting is off for files over 256 KB.'],
    [
      { kind: 'plain', reason: 'failed' },
      'Syntax highlighting failed, so this file is shown as plain text.',
    ],
    [
      { kind: 'plain', reason: 'timeout' },
      'Syntax highlighting took too long, so this file is shown as plain text.',
    ],
  ])('%j gives %j', (highlight, notice) => {
    expect(syntaxHighlightNotice(highlight)).toBe(notice);
  });
});
