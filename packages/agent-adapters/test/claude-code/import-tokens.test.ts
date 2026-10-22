import { describe, expect, it } from 'vitest';
import {
  importCandidates,
  IMPORT_TOKEN_MAX_LENGTH,
  type ImportCandidate,
} from '../../src/claude-code';

function candidates(text: string): ImportCandidate[] {
  return [...importCandidates(text)];
}

function tokens(text: string): string[] {
  return candidates(text).map((candidate) => `${candidate.kind}:${candidate.token}`);
}

describe('importCandidates (FR-118-27)', () => {
  it('reports absolute and home tokens', () => {
    expect(tokens('See @/etc/hostname and @~/notes.md and @~ too')).toEqual([
      'absolute:/etc/hostname',
      'home:~/notes.md',
      'home:~',
    ]);
  });

  it('reports relative tokens only when they contain a .. segment', () => {
    expect(tokens('@docs/context.md @./a.md @a..b @x/..y @~user/x')).toEqual([]);
    expect(tokens('@x/..). @y/..\\z')).toEqual([
      'relative:x/..).',
      'relative:x/',
      'relative:y/..\\z',
      'relative:y/..',
      'relative:y/',
    ]);
    expect(tokens('@.. @..\\x')).toEqual(['relative:..', 'relative:..\\x', 'relative:..']);
    expect(tokens('@../secret @a/../../b @x/..')).toEqual([
      'relative:../secret',
      'relative:a/../../b',
      'relative:x/..',
      'relative:x/',
    ]);
  });

  it('treats every @ as a token start, also inside a word, code span or fence', () => {
    expect(tokens('user@/etc/x `@/etc/y`\n```\n@/etc/z\n```')).toEqual([
      'absolute:/etc/x',
      'absolute:/etc/y`',
      'absolute:/etc/y',
      'absolute:/etc/z',
    ]);
    expect(tokens('@/a@/b')).toEqual(['absolute:/b', 'absolute:/a@/b']);
    expect(tokens('name@example.com, @ alone, trailing@')).toEqual([]);
  });

  it('also checks the token without trailing punctuation', () => {
    expect(tokens('(see @/etc/hostname).')).toEqual([
      'absolute:/etc/hostname).',
      'absolute:/etc/hostname',
    ]);
    expect(tokens('@~)')).toEqual(['home:~']);
    expect(tokens('@/...')).toEqual(['absolute:/...', 'absolute:/']);
  });

  it('continues over escaped spaces and checks both spellings', () => {
    expect(tokens('@/my\\ file.md next')).toEqual([
      'absolute:/my file.md',
      'absolute:/my\\ file.md',
    ]);
  });

  it('also stops at a backslash that does not escape a space', () => {
    expect(tokens('@/etc/hostname\\x')).toEqual([
      'absolute:/etc/hostname\\x',
      'absolute:/etc/hostname',
    ]);
    expect(tokens('@~\\x')).toEqual(['home:~']);
  });

  it('ends a token at any JavaScript whitespace', () => {
    const [nbsp, ideographic, lineSeparator] = [0xa0, 0x3000, 0x2028].map((c) =>
      String.fromCharCode(c),
    );
    expect(tokens(`@/a${nbsp}b @/c${ideographic}d @/e${lineSeparator}f`)).toEqual([
      'absolute:/a',
      'absolute:/c',
      'absolute:/e',
    ]);
  });

  it('skips a token too long to name a file, unless normalising could shorten it', () => {
    const long = 'a'.repeat(IMPORT_TOKEN_MAX_LENGTH);
    expect(tokens(`@/${long}`)).toEqual([]);
    expect(tokens(`@/${'a'.repeat(IMPORT_TOKEN_MAX_LENGTH - 2)}`)).toHaveLength(1);
    for (const text of [
      `@/${long}/../etc`,
      `@//${long}`,
      `@/x/./${long}`,
      `@/${long}\\ x`,
      `@./${long}/..`,
    ]) {
      expect(candidates(text).at(-1)?.kind, text.slice(0, 12)).toBe('too-long');
    }
    const cut = candidates(`@/etc/hostname\\${long}`);
    expect(cut.map((candidate) => candidate.token)).toEqual(['/etc/hostname']);
  });

  it('is linear in the input size, also for adversarial runs of @', () => {
    const inputs = [
      (n: number) => '@'.repeat(n),
      (n: number) => '@a'.repeat(n / 2),
      (n: number) => `${'@a'.repeat(n / 2)}/../x`,
      (n: number) => 'word@host.example '.repeat(n / 18),
      (n: number) => `@${'/'.repeat(n)}`,
    ];
    for (const make of inputs) {
      const time = (size: number) => {
        const text = make(size);
        const started = performance.now();
        let count = 0;
        for (const candidate of importCandidates(text)) {
          count += candidate.token.length > 0 ? 1 : 0;
          // Bounded like the scanner: it stops resolving after its candidate limit.
          if (count > 100_000) break;
        }
        return performance.now() - started;
      };
      time(200_000);
      const small = Math.max(time(400_000), 1);
      const large = time(1_600_000);
      // Linear: about 4×; quadratic would be 16×. The bound is wide for a loaded runner.
      expect(large / small, make(8)).toBeLessThan(12);
    }
  });
});
