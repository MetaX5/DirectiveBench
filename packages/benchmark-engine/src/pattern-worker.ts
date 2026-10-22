import { Worker } from 'node:worker_threads';

/**
 * Deadline for all user regular expressions of one assertion evaluation (SPEC-118 FR-118-46).
 * A syntax check does not bound matching time: `(a+)+$` backtracks exponentially.
 */
export const ASSERTION_REGEX_TIMEOUT_MS = 2000;

export interface PatternJob {
  pattern: string;
  flags: string;
  texts: readonly string[];
  /** Stop at the first matching text. */
  firstOnly: boolean;
}

export interface PatternError {
  code: 'pattern-timeout' | 'pattern-worker-failed';
  message: string;
}

/** Per job, the indexes of the texts its pattern matches, in ascending order. */
export type PatternOutcome = { ok: true; matches: number[][] } | { ok: false; error: PatternError };

export const PATTERN_TIMEOUT_MESSAGE = `Pattern evaluation exceeded ${ASSERTION_REGEX_TIMEOUT_MS} ms; simplify the regular expression`;

/**
 * Worker body, evaluated from source so it runs the same from TypeScript sources, the bundled
 * CLI and the packed tarball. Definitions only allow the flags `imsu`, so `test` is stateless.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage(
  workerData.map((job) => {
    const regex = new RegExp(job.pattern, job.flags);
    const matches = [];
    for (let index = 0; index < job.texts.length; index += 1) {
      if (regex.test(job.texts[index])) {
        matches.push(index);
        if (job.firstOnly) break;
      }
    }
    return matches;
  }),
);
`;

/**
 * Matches user-supplied regular expressions in a `node:worker_threads` worker, never on the
 * caller's event loop. One worker serves one call; it is terminated when it answers, after
 * `ASSERTION_REGEX_TIMEOUT_MS` or when `signal` aborts. Never rejects.
 */
export function matchPatterns(
  jobs: readonly PatternJob[],
  signal: AbortSignal,
): Promise<PatternOutcome> {
  if (jobs.length === 0) return Promise.resolve({ ok: true, matches: [] });
  if (signal.aborted) {
    return Promise.resolve({
      ok: false,
      error: { code: 'pattern-worker-failed', message: 'Pattern evaluation cancelled' },
    });
  }
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: jobs });
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
    worker.once('message', (matches: number[][]) => finish({ ok: true, matches }));
    worker.once('error', (error: Error) =>
      fail('pattern-worker-failed', `Pattern evaluation failed: ${error.message}`),
    );
  });
}
