import { describe, expect, it } from 'vitest';
import {
  ASSERTION_REGEX_TIMEOUT_MS,
  MAX_PATTERN_INPUT_CHARS,
  matchPatterns,
  placeMatchers,
  PATTERN_TIMEOUT_MESSAGE,
  workerPayload,
  type PatternRequest,
} from '../src/pattern-worker';
import { ADVERSARIAL } from './helpers';

const signal = () => new AbortController().signal;

/** Wide margin for worker start-up and termination on a loaded runner (lesson 2026-10-21). */
const MARGIN_MS = 3000;

const one = (pattern: string, text: string): PatternRequest => ({
  matchers: [{ pattern, flags: '' }],
  texts: [text],
  ordered: false,
});

describe('matchPatterns', () => {
  it('returns the first match of each pattern, as on the main thread', async () => {
    const texts = ['Backend API', 'backend api', 'Widget', 'PM review', 'x\ny', ''];
    const patterns = [
      { pattern: 'backend', flags: 'i' },
      { pattern: 'backend', flags: '' },
      { pattern: 'PM\\b', flags: '' },
      { pattern: '^y$', flags: 'm' },
      { pattern: 'x.y', flags: 's' },
      { pattern: '\\p{Lu}', flags: 'u' },
      { pattern: '^$', flags: '' },
      { pattern: 'absent', flags: '' },
    ];
    const expected = patterns.map(({ pattern, flags }) =>
      texts.findIndex((text) => new RegExp(pattern, flags).test(text)),
    );
    expect(expected).toEqual([0, 1, 3, 4, 4, 0, 5, -1]);
    expect(await matchPatterns({ matchers: patterns, texts, ordered: false }, signal())).toEqual({
      ok: true,
      first: expected,
      placed: null,
    });
    // The same function on the runner thread gives the same placement.
    expect(placeMatchers(patterns, texts, false)).toEqual({ first: expected, placed: null });
  });

  it('places literals and patterns greedily in order', async () => {
    const texts = ['Step 1', 'Summary', 'Step 2', 'Risks'];
    const matchers = [
      { pattern: '^Step', flags: '' },
      { literal: 'summary' },
      { pattern: '^Step', flags: '' },
      { literal: 'risks' },
      { literal: 'summary' },
    ];
    const placement = { first: [0, 1, 0, 3, 1], placed: [0, 1, 2, 3, -1] };
    expect(await matchPatterns({ matchers, texts, ordered: true }, signal())).toEqual({
      ok: true,
      ...placement,
    });
    expect(placeMatchers(matchers, texts, true)).toEqual(placement);
    expect(placeMatchers([{ literal: 'risks' }], texts, false)).toEqual({
      first: [3],
      placed: null,
    });
  });

  it('starts no worker without matchers', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await matchPatterns({ matchers: [], texts: ['a'], ordered: true }, controller.signal),
    ).toEqual({ ok: true, first: [], placed: [] });
    expect(
      await matchPatterns({ matchers: [], texts: ['a'], ordered: false }, controller.signal),
    ).toEqual({ ok: true, first: [], placed: null });
  });

  it('sends the texts once, shared by every matcher', () => {
    const texts = ['x'.repeat(1024)];
    const matchers = [
      ...Array.from({ length: 99 }, (_, i) => ({ pattern: `p${i}`, flags: 'i', extra: 'dropped' })),
      { literal: 'x' },
    ];
    const payload = workerPayload({ matchers, texts, ordered: false });
    // One reference to the document; matchers carry only their sources.
    expect(payload.texts).toBe(texts);
    expect(payload.matchers.at(-1)).toEqual({ literal: 'x' });
    expect(payload.matchers[0]).toEqual({ pattern: 'p0', flags: 'i' });
    expect(JSON.stringify(payload).length).toBeLessThan(1024 + 100 * 40);
  });

  it('returns results proportional to the matchers, not to the matching texts', async () => {
    // 50 000 headings that every pattern matches: per-match index lists would hold 5 000 000
    // numbers; the compact result holds two per matcher.
    const texts = Array.from({ length: 50_000 }, () => 'a');
    const matchers = Array.from({ length: 100 }, () => ({ pattern: 'a', flags: '' }));
    const outcome = await matchPatterns({ matchers, texts, ordered: true }, signal());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.first).toHaveLength(100);
    expect(outcome.placed).toHaveLength(100);
    expect(outcome.first.every((index) => index === 0)).toBe(true);
    expect(outcome.placed).toEqual(matchers.map((_, i) => i));
    expect(JSON.stringify(outcome).length).toBeLessThan(2000);
  }, 20_000);

  it('fails closed before copying an input above the limit to a worker', async () => {
    const started = performance.now();
    const outcome = await matchPatterns(
      {
        matchers: [{ pattern: 'a', flags: '' }],
        texts: ['x'.repeat(MAX_PATTERN_INPUT_CHARS)],
        ordered: false,
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
    const matchers = Array.from({ length: 100 }, (_, i) => ({
      pattern: `needle|n${i}x`,
      flags: '',
    }));
    const outcome = await matchPatterns({ matchers, texts: [text], ordered: false }, signal());
    expect(outcome).toEqual({ ok: true, first: matchers.map(() => 0), placed: null });
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
      { matchers: [{ pattern: 'a', flags: '' }], texts, ordered: false },
      signal(),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'pattern-worker-failed' } });
    if (!outcome.ok) expect(outcome.error.message).toMatch(/^Pattern evaluation failed: /);
  });
});
