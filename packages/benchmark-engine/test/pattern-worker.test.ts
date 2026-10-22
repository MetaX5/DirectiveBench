import { describe, expect, it } from 'vitest';
import {
  ASSERTION_REGEX_TIMEOUT_MS,
  MAX_PATTERN_INPUT_CHARS,
  matchPatterns,
  PATTERN_TIMEOUT_MESSAGE,
  workerPayload,
  type PatternRequest,
} from '../src/pattern-worker';
import { ADVERSARIAL } from './helpers';

const signal = () => new AbortController().signal;

/** Wide margin for worker start-up and termination on a loaded runner (lesson 2026-10-21). */
const MARGIN_MS = 3000;

const one = (pattern: string, text: string): PatternRequest => ({
  patterns: [{ pattern, flags: '' }],
  texts: [text],
  firstOnly: true,
});

describe('matchPatterns', () => {
  it('returns the same matches as evaluating the patterns on the main thread', async () => {
    const texts = ['Backend API', 'backend api', 'Widget', 'PM review', 'x\ny', ''];
    const patterns = [
      { pattern: 'backend', flags: 'i' },
      { pattern: 'backend', flags: '' },
      { pattern: 'PM\\b', flags: '' },
      { pattern: '^y$', flags: 'm' },
      { pattern: 'x.y', flags: 's' },
      { pattern: '\\p{Lu}', flags: 'u' },
      { pattern: '^$', flags: '' },
    ];
    const expected = patterns.map(({ pattern, flags }) =>
      texts.flatMap((text, index) => (new RegExp(pattern, flags).test(text) ? [index] : [])),
    );
    expect(await matchPatterns({ patterns, texts, firstOnly: false }, signal())).toEqual({
      ok: true,
      matches: expected,
    });
    expect(expected[0]).toEqual([0, 1]);
  });

  it('stops at the first match when asked to', async () => {
    const outcome = await matchPatterns(
      { patterns: [{ pattern: 'a', flags: '' }], texts: ['b', 'a', 'a'], firstOnly: true },
      signal(),
    );
    expect(outcome).toEqual({ ok: true, matches: [[1]] });
  });

  it('starts no worker without patterns', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await matchPatterns({ patterns: [], texts: ['a'], firstOnly: true }, controller.signal),
    ).toEqual({ ok: true, matches: [] });
  });

  it('sends the texts once, shared by every pattern', () => {
    const texts = ['x'.repeat(1024)];
    const patterns = Array.from({ length: 100 }, (_, i) => ({ pattern: `p${i}`, flags: 'i' }));
    const payload = workerPayload({ patterns, texts, firstOnly: false });
    // One reference to the document; patterns carry only their sources and flags.
    expect(payload.texts).toBe(texts);
    expect(payload.patterns.every((p) => Object.keys(p).join() === 'pattern,flags')).toBe(true);
    expect(JSON.stringify(payload).length).toBeLessThan(1024 + 100 * 40);
  });

  it('fails closed before copying an input above the limit to a worker', async () => {
    const started = performance.now();
    const outcome = await matchPatterns(
      {
        patterns: [{ pattern: 'a', flags: '' }],
        texts: ['x'.repeat(MAX_PATTERN_INPUT_CHARS)],
        firstOnly: true,
      },
      signal(),
    );
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'pattern-worker-failed',
        message: `Pattern input of ${MAX_PATTERN_INPUT_CHARS + 1} characters exceeds ${MAX_PATTERN_INPUT_CHARS}; patterns were not evaluated`,
      },
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('evaluates many patterns over a 2 MiB text in one worker within the deadline', async () => {
    const text = `${'word '.repeat(400_000)}needle`;
    const patterns = Array.from({ length: 100 }, (_, i) => ({
      pattern: `needle|n${i}x`,
      flags: '',
    }));
    const outcome = await matchPatterns({ patterns, texts: [text], firstOnly: true }, signal());
    expect(outcome).toEqual({ ok: true, matches: patterns.map(() => [0]) });
  }, 20_000);

  it('ends adversarial patterns with a timeout error within the deadline', async () => {
    const started = performance.now();
    const outcomes = await Promise.all(
      ADVERSARIAL.map(({ pattern, text }) => matchPatterns(one(pattern, text), signal())),
    );
    const elapsed = performance.now() - started;
    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        ok: false,
        error: { code: 'pattern-timeout', message: PATTERN_TIMEOUT_MESSAGE },
      });
    }
    expect(PATTERN_TIMEOUT_MESSAGE).toBe(
      'Pattern evaluation exceeded 2000 ms; simplify the regular expression',
    );
    expect(elapsed).toBeGreaterThanOrEqual(ASSERTION_REGEX_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(ASSERTION_REGEX_TIMEOUT_MS + MARGIN_MS);
  }, 20_000);

  it('keeps timers on the calling thread firing while a pattern runs', async () => {
    let ticks = 0;
    const interval = setInterval(() => (ticks += 1), 50);
    try {
      const { pattern, text } = ADVERSARIAL[0] as (typeof ADVERSARIAL)[number];
      expect((await matchPatterns(one(pattern, text), signal())).ok).toBe(false);
    } finally {
      clearInterval(interval);
    }
    // 40 ticks in 2 s on an idle thread; a blocked event loop would deliver at most one.
    expect(ticks).toBeGreaterThanOrEqual(5);
  }, 20_000);

  it('terminates the worker at once when the signal aborts', async () => {
    const controller = new AbortController();
    const { pattern, text } = ADVERSARIAL[0] as (typeof ADVERSARIAL)[number];
    const started = performance.now();
    const pending = matchPatterns(one(pattern, text), controller.signal);
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'pattern-worker-failed', message: 'Pattern evaluation cancelled' },
    });
    expect(performance.now() - started).toBeLessThan(ASSERTION_REGEX_TIMEOUT_MS - 500);
  }, 20_000);

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await matchPatterns(one('a', 'a'), controller.signal)).toEqual({
      ok: false,
      error: { code: 'pattern-worker-failed', message: 'Pattern evaluation cancelled' },
    });
  });

  it('reports a crashed evaluation with its reason', async () => {
    // Definitions reject invalid patterns; the worker still fails closed if one gets through.
    const outcome = await matchPatterns(one('(', 'a'), signal());
    expect(outcome).toMatchObject({ ok: false, error: { code: 'pattern-worker-failed' } });
    if (!outcome.ok) expect(outcome.error.message).toMatch(/^Pattern evaluation failed: Invalid/);
  });

  it('fails closed when the worker cannot be started', async () => {
    // Uncloneable worker data makes the Worker constructor throw synchronously, like a process
    // started with `--permission` but without `--allow-worker`.
    const texts = [() => 'not cloneable'] as unknown as string[];
    const outcome = await matchPatterns(
      { patterns: [{ pattern: 'a', flags: '' }], texts, firstOnly: true },
      signal(),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'pattern-worker-failed' } });
    if (!outcome.ok) expect(outcome.error.message).toMatch(/^Pattern evaluation failed: /);
  });
});
