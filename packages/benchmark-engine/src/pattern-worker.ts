import { Worker } from 'node:worker_threads';

/**
 * Deadline for all user regular expressions of one assertion evaluation (SPEC-118 FR-118-46).
 * A syntax check does not bound matching time: `(a+)+$` backtracks exponentially.
 */
export const ASSERTION_REGEX_TIMEOUT_MS = 2000;

/** A user regular expression; definitions only allow the flags `imsu`. */
export interface PatternSource {
  pattern: string;
  flags: string;
}

/** A literal compared with each text lower-cased (texts arrive whitespace-collapsed). */
export interface LiteralSource {
  literal: string;
}

export type MatcherSource = PatternSource | LiteralSource;

/** Every matcher is matched against the same texts, which are sent to the worker once. */
export interface PatternRequest {
  matchers: readonly MatcherSource[];
  texts: readonly string[];
  /** Also place the matchers greedily in order (`placed`). */
  ordered: boolean;
}

/**
 * Compact results, O(matchers) whatever the number of texts: per matcher the first matching
 * text index, and with `ordered` its greedy position after the previous matcher's (-1: none).
 */
export interface Placement {
  first: number[];
  placed: number[] | null;
}

/**
 * Most characters (texts plus matcher sources) one worker receives. A document assertion reads
 * at most 2 MiB and its matchers are capped by the definition schema, so this only stops inputs
 * no definition can produce, before anything is copied to a worker.
 */
export const MAX_PATTERN_INPUT_CHARS = 4 * 1024 * 1024;

export interface PatternError {
  code: 'pattern-timeout' | 'pattern-worker-failed';
  message: string;
}

export type PatternOutcome = ({ ok: true } & Placement) | { ok: false; error: PatternError };

export const PATTERN_TIMEOUT_MESSAGE = `Pattern evaluation exceeded ${ASSERTION_REGEX_TIMEOUT_MS} ms; simplify the regular expression`;

/**
 * Matches `matchers` against `texts`: the first matching index of each, and with `ordered` the
 * greedy placement (each takes its first match after the previous placed one; an unplaced one
 * leaves the cursor). Runs on the runner thread for literals only, and in the worker — from its
 * source text, so it must stay self-contained — whenever a user pattern is involved.
 */
export function placeMatchers(
  matchers: readonly MatcherSource[],
  texts: readonly string[],
  ordered: boolean,
): Placement {
  let lowered: string[] | null = null;
  const tests = matchers.map((matcher) => {
    if ('literal' in matcher) {
      return (index: number) => {
        if (lowered === null) lowered = texts.map((text) => text.toLowerCase());
        return lowered[index] === matcher.literal;
      };
    }
    const regex = new RegExp(matcher.pattern, matcher.flags);
    return (index: number) => regex.test(texts[index] as string);
  });
  const firstAfter = (test: (index: number) => boolean, after: number): number => {
    for (let index = after + 1; index < texts.length; index += 1) if (test(index)) return index;
    return -1;
  };
  const first = tests.map((test) => firstAfter(test, -1));
  if (!ordered) return { first, placed: null };
  let cursor = -1;
  const placed = tests.map((test) => {
    const position = firstAfter(test, cursor);
    if (position >= 0) cursor = position;
    return position;
  });
  return { first, placed };
}

/**
 * Worker body, evaluated from source so it runs the same from TypeScript sources, the bundled
 * CLI and the packed tarball. Definitions only allow the flags `imsu`, so `test` is stateless.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const placeMatchers = (${placeMatchers.toString()});
parentPort.postMessage(placeMatchers(workerData.matchers, workerData.texts, workerData.ordered));
`;

/**
 * What the worker receives: the texts once, shared by every matcher, so the structured clone is
 * proportional to the document, not to the document times the number of matchers.
 */
export function workerPayload(request: PatternRequest): PatternRequest {
  return {
    matchers: request.matchers.map((matcher) =>
      'literal' in matcher
        ? { literal: matcher.literal }
        : { pattern: matcher.pattern, flags: matcher.flags },
    ),
    texts: request.texts,
    ordered: request.ordered,
  };
}

function inputChars(request: PatternRequest): number {
  let total = 0;
  for (const text of request.texts) total += text.length;
  for (const matcher of request.matchers) {
    total += 'literal' in matcher ? matcher.literal.length : matcher.pattern.length;
  }
  return total;
}

/**
 * Matches user-supplied regular expressions in a `node:worker_threads` worker, never on the
 * caller's event loop. One worker serves one call; it is terminated when it answers, after
 * `ASSERTION_REGEX_TIMEOUT_MS` or when `signal` aborts. Never rejects.
 */
export function matchPatterns(
  request: PatternRequest,
  signal: AbortSignal,
): Promise<PatternOutcome> {
  if (request.matchers.length === 0) {
    return Promise.resolve({ ok: true, first: [], placed: request.ordered ? [] : null });
  }
  const chars = inputChars(request);
  if (chars > MAX_PATTERN_INPUT_CHARS) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'pattern-worker-failed',
        message: `Pattern input of ${chars} characters exceeds ${MAX_PATTERN_INPUT_CHARS}; patterns were not evaluated`,
      },
    });
  }
  if (signal.aborted) {
    return Promise.resolve({
      ok: false,
      error: { code: 'pattern-worker-failed', message: 'Pattern evaluation cancelled' },
    });
  }
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: workerPayload(request) });
  } catch (error) {
    // E.g. worker threads disallowed by the permission model, or uncloneable data: fail closed
    // as an assertion error, never as a scored failure.
    return Promise.resolve({
      ok: false,
      error: {
        code: 'pattern-worker-failed',
        message: `Pattern evaluation failed: ${(error as Error).message}`,
      },
    });
  }
  return new Promise((resolve) => {
    const finish = (outcome: PatternOutcome): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // Repeated calls are harmless: a promise settles once. The `error` listener stays attached
      // so a late worker error can never become an unhandled `error` event.
      // Resolves with the exit code; there is nothing to recover if the thread is already gone.
      void worker.terminate();
      resolve(outcome);
    };
    const fail = (code: PatternError['code'], message: string) =>
      finish({ ok: false, error: { code, message } });
    // A worker that exits without answering is also caught by this deadline.
    const timer = setTimeout(
      () => fail('pattern-timeout', PATTERN_TIMEOUT_MESSAGE),
      ASSERTION_REGEX_TIMEOUT_MS,
    );
    const onAbort = () => fail('pattern-worker-failed', 'Pattern evaluation cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (placement: Placement) => finish({ ok: true, ...placement }));
    worker.once('error', (error: Error) =>
      fail('pattern-worker-failed', `Pattern evaluation failed: ${error.message}`),
    );
  });
}
