import { describe, expect, it } from 'vitest';
import { cn, formatDate, formatDelta, formatDuration, formatScore } from '../lib/utils';

describe('cn', () => {
  it('joins conditional classes and lets later Tailwind classes win', () => {
    expect(cn('px-2 text-sm', false, null, undefined, { hidden: false, block: true }, 'px-4')).toBe(
      'text-sm block px-4',
    );
  });
});

describe('cn with design tokens', () => {
  it('treats the text-* tokens as font sizes, so a text colour does not replace them', () => {
    expect(cn('text-caption text-muted-foreground')).toBe('text-caption text-muted-foreground');
    expect(cn('text-metric', 'text-xs')).toBe('text-xs');
    expect(cn('text-sm', 'text-page-title')).toBe('text-page-title');
  });

  it('lets later spacing, radius and width tokens replace the classes they stand for', () => {
    expect(cn('h-8', 'h-control')).toBe('h-control');
    expect(cn('gap-4', 'gap-grid')).toBe('gap-grid');
    expect(cn('px-2', 'px-page-inline')).toBe('px-page-inline');
    expect(cn('w-56', 'w-sidebar')).toBe('w-sidebar');
    expect(cn('rounded-md', 'rounded-surface')).toBe('rounded-surface');
    expect(cn('max-w-6xl', 'max-w-content')).toBe('max-w-content');
  });
});

describe('formatDate', () => {
  it('renders an ISO timestamp in UTC, independent of the local time zone', () => {
    expect(formatDate('2026-10-15T08:05:00.000Z')).toBe('15 Oct 2026, 08:05 UTC');
  });

  it.each([null, undefined, ''])('renders a dash for a missing value (%j)', (value) => {
    expect(formatDate(value)).toBe('—');
  });
});

describe('formatScore', () => {
  it.each([
    [1, '100%'],
    [0, '0%'],
    [0.5, '50%'],
    [0.12345, '12.3%'],
  ])('formats %d as a percentage with one decimal', (score, expected) => {
    expect(formatScore(score)).toBe(expected);
  });

  it.each([null, undefined])('renders a dash for %j', (score) => {
    expect(formatScore(score)).toBe('—');
  });
});

describe('formatDelta', () => {
  it.each([
    [0.5, '+50 pts'],
    [0.0123, '+1.2 pts'],
    [0, '0 pts'],
    [-0.25, '-25 pts'],
  ])('formats %d as signed percentage points', (delta, expected) => {
    expect(formatDelta(delta)).toBe(expected);
  });

  it.each([null, undefined])('renders a dash for %j', (delta) => {
    expect(formatDelta(delta)).toBe('—');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [999, '999 ms'],
    [1000, '1.0 s'],
    [12_345, '12.3 s'],
  ])('formats %d ms', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it.each([null, undefined])('renders a dash for %j', (ms) => {
    expect(formatDuration(ms)).toBe('—');
  });
});
