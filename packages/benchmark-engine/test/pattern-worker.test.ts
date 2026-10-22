import { describe, expect, it } from 'vitest';
import {
  ASSERTION_REGEX_TIMEOUT_MS,
  matchPatterns,
  PATTERN_TIMEOUT_MESSAGE,
  type PatternJob,
} from '../src/pattern-worker';
import { ADVERSARIAL } from './helpers';

const signal = () => new AbortController().signal;

/** Wide margin for worker start-up and termination on a loaded runner (lesson 2026-10-21). */
const MARGIN_MS = 3000;

describe('matchPatterns', () => {
  it('returns the same matches as evaluating the patterns on the main thread', async () => {
    const texts = ['Backend API', 'backend api', 'Widget', 'PM review', 'x\ny', ''];
    const jobs: PatternJob[] = [
      { pattern: 'backend', flags: 'i', texts, firstOnly: false },
      { pattern: 'backend', flags: '', texts, firstOnly: false },
      { pattern: 'PM\\b', flags: '', texts, firstOnly: false },
      { pattern: '^y$', flags: 'm', texts, firstOnly: false },
      { pattern: 'x.y', flags: 's', texts, firstOnly: false },
      { pattern: '\\p{Lu}', flags: 'u', texts, firstOnly: false },
      { pattern: '^$', flags: '', texts, firstOnly: false },
    ];
    const expected = jobs.map((job) =>
      texts.flatMap((text, index) =>
        new RegExp(job.pattern, job.flags).test(text) ? [index] : [],
      ),
    );
    expect(await matchPatterns(jobs, signal())).toEqual({ ok: true, matches: expected });
    expect(expected[0]).toEqual([0, 1]);
  });

  it('stops at the first match when asked to', async () => {
    const outcome = await matchPatterns(
      [{ pattern: 'a', flags: '', texts: ['b', 'a', 'a'], firstOnly: true }],
      signal(),
    );
    expect(outcome).toEqual({ ok: true, matches: [[1]] });
  });

  it('starts no worker for an empty job list', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await matchPatterns([], controller.signal)).toEqual({ ok: true, matches: [] });
  });

  it('ends adversarial patterns with a timeout error within the deadline', async () => {
    const started = performance.now();
    const outcomes = await Promise.all(
      ADVERSARIAL.map(({ pattern, text }) =>
        matchPatterns([{ pattern, flags: '', texts: [text], firstOnly: true }], signal()),
      ),
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
      const outcome = await matchPatterns(
        [{ pattern, flags: '', texts: [text], firstOnly: true }],
        signal(),
      );
      expect(outcome.ok).toBe(false);
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
    const pending = matchPatterns(
      [{ pattern, flags: '', texts: [text], firstOnly: true }],
      controller.signal,
    );
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
    const outcome = await matchPatterns(
      [{ pattern: 'a', flags: '', texts: ['a'], firstOnly: true }],
      controller.signal,
    );
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'pattern-worker-failed', message: 'Pattern evaluation cancelled' },
    });
  });

  it('reports a crashed evaluation with its reason', async () => {
    // Definitions reject invalid patterns; the worker still fails closed if one gets through.
    const outcome = await matchPatterns(
      [{ pattern: '(', flags: '', texts: ['a'], firstOnly: true }],
      signal(),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'pattern-worker-failed' } });
    if (!outcome.ok) expect(outcome.error.message).toMatch(/^Pattern evaluation failed: Invalid/);
  });

  it('fails closed when the worker cannot be started', async () => {
    // Uncloneable worker data makes the Worker constructor throw synchronously, like a process
    // started with `--permission` but without `--allow-worker`.
    const texts = [() => 'not cloneable'] as unknown as string[];
    const outcome = await matchPatterns(
      [{ pattern: 'a', flags: '', texts, firstOnly: true }],
      signal(),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'pattern-worker-failed' } });
    if (!outcome.ok) expect(outcome.error.message).toMatch(/^Pattern evaluation failed: /);
  });
});
