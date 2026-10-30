import 'server-only';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import {
  SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS,
  SYNTAX_HIGHLIGHT_MAX_BYTES,
  type HighlightJob,
  type HighlightJobResult,
  type HighlightOptions,
  type HighlightResult,
  type SyntaxLanguage,
} from './syntax-highlight-common';

// Server-side syntax highlighting of output files (SPEC-123 §6.7, ADR-0014), called by App
// Router Server Components. The request thread never runs Shiki: each page render sends its
// texts (at most two, the sides of a diff) as one job to a `node:worker_threads` worker, and a
// job that passes SYNTAX_HIGHLIGHT_DEADLINE_MS terminates that worker, which is the only way to
// stop a synchronous RegExp.exec (FR-123-78). Components receive the result as plain data.

export {
  languageForPath,
  SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS,
  SYNTAX_HIGHLIGHT_MAX_BYTES,
  SYNTAX_HIGHLIGHT_MAX_LINE_CHARS,
  SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT,
  SYNTAX_LANGUAGE_BY_EXTENSION,
  type HighlightedLine,
  type HighlightOptions,
  type HighlightResult,
  type SyntaxLanguage,
  type SyntaxTokenKind,
} from './syntax-highlight-common';

/**
 * Aggregate deadline of one page render's highlighting, from the moment it is submitted: the
 * wait for the worker, the worker's start and highlighter creation, and every text of the job
 * (FR-123-78, NFR-123-07). The only hard bound on time.
 */
export const SYNTAX_HIGHLIGHT_DEADLINE_MS = 2_000;
/** Jobs that may wait while the worker runs another; a job beyond them is not highlighted. */
export const SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS = 8;

/** One text of a page render: the file content and the language of its path, if any. */
export interface HighlightText {
  text: string;
  language: SyntaxLanguage | null;
}

export interface HighlightWorkerPoolOptions {
  /** Starts the worker thread; called lazily for a job when no worker is alive. */
  createWorker: () => Worker;
  deadlineMs: number;
  maxQueuedJobs: number;
}

export interface HighlightWorkerPool {
  /** One result per text, in order; never rejects. */
  run: (job: HighlightJob) => Promise<HighlightResult[]>;
}

interface PendingJob {
  job: HighlightJob;
  resolve: (results: HighlightResult[]) => void;
  timer: NodeJS.Timeout;
  /** `performance.now()` at which the deadline passes. */
  expiresAt: number;
}

function plain(job: HighlightJob, reason: 'failed' | 'timeout'): HighlightResult[] {
  return job.texts.map(() => ({ kind: 'plain', reason }));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * One highlight worker per pool, running one job at a time with at most `maxQueuedJobs`
 * waiting (FR-123-78). A job not answered within `deadlineMs` of being submitted terminates the
 * worker, every job of that worker (running or waiting) ends as plain text, and the next job
 * starts a new worker. A worker that cannot start, throws or exits ends its jobs as `failed`
 * and is replaced in the same way. Problems are logged without file content (FR-123-74).
 */
export function createHighlightWorkerPool({
  createWorker,
  deadlineMs,
  maxQueuedJobs,
}: HighlightWorkerPoolOptions): HighlightWorkerPool {
  let worker: Worker | null = null;
  let running: PendingJob | null = null;
  const queue: PendingJob[] = [];

  function settle(pending: PendingJob, results: HighlightResult[]) {
    clearTimeout(pending.timer);
    pending.resolve(results);
  }

  /** Stops the worker (also inside a synchronous loop) and ends all its jobs as plain text. */
  function discardWorker(reason: 'failed' | 'timeout') {
    const current = worker;
    worker = null;
    // terminate() resolves once the thread stopped; nothing waits for it. It does not reject.
    void current?.terminate();
    const jobs = running ? [running, ...queue] : [...queue];
    running = null;
    queue.length = 0;
    for (const pending of jobs) settle(pending, plain(pending.job, reason));
  }

  function startWorker(): Worker {
    const started = createWorker();
    // The server must not wait for an idle highlighter to exit.
    started.unref();
    started.on('message', (result: HighlightJobResult) => {
      if (started !== worker || !running) return;
      // A busy request thread can deliver the answer before the overdue deadline timer: the
      // deadline is checked here too, so a late answer never counts (Codex review round 1).
      if (performance.now() >= running.expiresAt) {
        timeOut();
        return;
      }
      const done = running;
      running = null;
      settle(done, result.results);
      startNext();
    });
    started.on('error', (error: unknown) => {
      if (started !== worker) return;
      // eslint-disable-next-line no-console -- FR-123-74 requires a server log of the failure
      console.error(`Syntax highlighting worker failed: ${errorName(error)}`);
      discardWorker('failed');
    });
    started.on('exit', (code: number) => {
      if (started !== worker) return;
      // eslint-disable-next-line no-console -- FR-123-74 requires a server log of the failure
      console.error(`Syntax highlighting worker exited with code ${code}`);
      discardWorker('failed');
    });
    return started;
  }

  function startNext() {
    if (running) return;
    const next = queue.shift();
    if (!next) return;
    try {
      worker ??= startWorker();
    } catch (error) {
      // Not memoised: the next job tries to start a worker again (FR-123-70).
      // eslint-disable-next-line no-console -- FR-123-74 requires a server log of the failure
      console.error(`Syntax highlighting worker did not start: ${errorName(error)}`);
      settle(next, plain(next.job, 'failed'));
      startNext();
      return;
    }
    running = next;
    worker.postMessage(next.job);
  }

  // Jobs start in submission order and share one deadline, so the job whose time runs out is
  // always the running one: every job queued behind it was submitted later.
  function timeOut() {
    // eslint-disable-next-line no-console -- an operator should see why a file is plain
    console.error(`Syntax highlighting took longer than ${deadlineMs} ms; the worker was stopped`);
    discardWorker('timeout');
  }

  return {
    run(job) {
      if (queue.length >= maxQueuedJobs) return Promise.resolve(plain(job, 'timeout'));
      return new Promise((resolve) => {
        queue.push({
          job,
          resolve,
          timer: setTimeout(timeOut, deadlineMs),
          expiresAt: performance.now() + deadlineMs,
        });
        startNext();
      });
    },
  };
}

let pool: HighlightWorkerPool | null = null;

/** The worker pool of this server process, created on first use. */
function serverPool(): HighlightWorkerPool {
  pool ??= createHighlightWorkerPool({
    // This exact expression lets Next.js bundle the worker entry and its imports (FR-123-77).
    createWorker: () => new Worker(new URL('./syntax-highlight-worker.ts', import.meta.url)),
    deadlineMs: SYNTAX_HIGHLIGHT_DEADLINE_MS,
    maxQueuedJobs: SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS,
  });
  return pool;
}

/**
 * Highlights the texts of one page render (one file, or the two sides of a diff) as one job
 * with one deadline, and returns one result per text, in order. Texts without a language or
 * over SYNTAX_HIGHLIGHT_MAX_BYTES are answered here without the worker. Never rejects.
 */
export async function highlightTexts(
  texts: readonly HighlightText[],
  { lineTimeLimitMs = SYNTAX_HIGHLIGHT_LINE_TIME_LIMIT_MS }: HighlightOptions = {},
): Promise<HighlightResult[]> {
  const job: HighlightJob = { texts: [], lineTimeLimitMs };
  const results = texts.map(({ text, language }): HighlightResult | null => {
    if (language === null) return { kind: 'plain', reason: 'no-language' };
    if (Buffer.byteLength(text, 'utf8') > SYNTAX_HIGHLIGHT_MAX_BYTES) {
      return { kind: 'plain', reason: 'too-large' };
    }
    job.texts.push({ text, language });
    return null;
  });
  const tokenized = job.texts.length > 0 ? await serverPool().run(job) : [];
  return results.map((result) => result ?? tokenized.shift()!);
}

/** Highlights one text (FR-123-72): `highlightTexts` with a job of its own. */
export async function highlightLines(
  text: string,
  language: SyntaxLanguage | null,
  options: HighlightOptions = {},
): Promise<HighlightResult> {
  const [result] = await highlightTexts([{ text, language }], options);
  return result!;
}
