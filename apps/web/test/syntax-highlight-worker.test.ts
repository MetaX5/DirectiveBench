import { EventEmitter } from 'node:events';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HighlightJob } from '../lib/syntax-highlight-common';
import {
  createHighlightWorkerPool,
  highlightLines,
  highlightTexts,
  SYNTAX_HIGHLIGHT_DEADLINE_MS,
  SYNTAX_HIGHLIGHT_MAX_BYTES,
  SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS,
  SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT,
} from '../lib/syntax-highlight';
import { runHighlightJob } from '../lib/syntax-highlight-worker';

// The highlight worker and its hard deadline (SPEC-123 FR-123-78, NFR-123-07, AC-16). Tests
// with real threads use small eval'd workers that stand in for a tokenizer stalled in a
// synchronous loop: terminate() must stop them, which no timer on the request thread can.

const job = (...texts: string[]): HighlightJob => ({
  texts: texts.map((text) => ({ text, language: 'typescript' })),
  lineTimeLimitMs: SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT,
});

const timeout = { kind: 'plain', reason: 'timeout' } as const;
const failed = { kind: 'plain', reason: 'failed' } as const;
const tokens = (text: string) => ({ kind: 'highlighted', lines: [[{ text, token: null }]] });

/** A worker thread from source code; `parentPort` is in scope. */
function evalWorker(source: string): Worker {
  return new Worker(`const { parentPort } = require('node:worker_threads');\n${source}`, {
    eval: true,
  });
}

/** Answers each job at once with every text as one uncoloured token. */
const echoSource = `parentPort.on('message', ({ texts }) => parentPort.postMessage({
  results: texts.map(({ text }) => ({ kind: 'highlighted', lines: [[{ text, token: null }]] })),
}));`;

/** A tokenizer stuck in a synchronous loop: only terminate() ends it. */
const stalledSource = `parentPort.on('message', () => { for (;;) {} });`;

/**
 * Many lines that each stay far under the cooperative per-line limit (500 ms) but together
 * take longer than any deadline below: 400 lines of 25 ms of synchronous work.
 */
const slowLinesSource = `parentPort.on('message', ({ texts }) => {
  for (let line = 0; line < 400; line += 1) {
    const end = Date.now() + 25;
    while (Date.now() < end) {}
  }
  parentPort.postMessage({ results: texts.map(() => ({ kind: 'plain', reason: 'failed' })) });
});`;

/** A stand-in worker whose events the test emits itself. */
class FakeWorker extends EventEmitter {
  readonly posted: HighlightJob[] = [];
  terminated = false;
  unref = vi.fn();
  postMessage(message: HighlightJob) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

function fakePool(options: { deadlineMs?: number; maxQueuedJobs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const pool = createHighlightWorkerPool({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    deadlineMs: options.deadlineMs ?? 60_000,
    maxQueuedJobs: options.maxQueuedJobs ?? SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS,
  });
  return { pool, workers };
}

let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logged.mockRestore();
  vi.useRealTimers();
});

describe('constants (SPEC-123 §8.2)', () => {
  it('match the spec', () => {
    expect(SYNTAX_HIGHLIGHT_DEADLINE_MS).toBe(2_000);
    expect(SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS).toBe(8);
  });
});

describe('the highlight worker (real thread)', () => {
  it('tokenizes every text of a page render in a worker thread, in order', async () => {
    const [left, none, right] = await highlightTexts(
      [
        { text: 'const a = 1;', language: 'typescript' },
        { text: 'a', language: null },
        { text: 'name: x', language: 'yaml' },
      ],
      { lineTimeLimitMs: SYNTAX_HIGHLIGHT_NO_LINE_TIME_LIMIT },
    );
    expect(left).toMatchObject({ kind: 'highlighted' });
    expect(none).toEqual({ kind: 'plain', reason: 'no-language' });
    expect(right).toMatchObject({ kind: 'highlighted' });
    expect(JSON.stringify(left)).toContain('"token":"keyword"');
  }, 30_000);

  it('answers texts without a language or over the size bound without a job', async () => {
    expect(
      await highlightTexts([
        { text: 'x'.repeat(SYNTAX_HIGHLIGHT_MAX_BYTES + 1), language: 'typescript' },
        { text: 'x', language: null },
      ]),
    ).toEqual([
      { kind: 'plain', reason: 'too-large' },
      { kind: 'plain', reason: 'no-language' },
    ]);
  });

  it('highlights one text with highlightLines, with the shipped per-line limit', async () => {
    const result = await highlightLines('<script>alert(1)</script>', 'html');
    // Markup is token text, never HTML (AC-15).
    expect(result.kind === 'highlighted' && result.lines[0]!.map((t) => t.text).join('')).toBe(
      '<script>alert(1)</script>',
    );
  }, 30_000);

  it('runs a job in order with runHighlightJob, the worker entry itself', async () => {
    const { results } = await runHighlightJob(job('let a;', ''));
    expect(results[0]).toMatchObject({ kind: 'highlighted' });
    expect(results[1]).toEqual({ kind: 'highlighted', lines: [] });
  });
});

describe('the worker entry module', () => {
  afterEach(() => {
    vi.doUnmock('node:worker_threads');
    vi.resetModules();
  });

  it('answers each message on its parent port', async () => {
    const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
    vi.resetModules();
    vi.doMock('node:worker_threads', () => ({ parentPort: port }));
    await import('../lib/syntax-highlight-worker');
    port.emit('message', job('let a;'));
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    expect(port.postMessage.mock.calls[0]![0]).toMatchObject({
      results: [{ kind: 'highlighted' }],
    });
  });
});

describe('createHighlightWorkerPool deadline (FR-123-78, AC-16)', () => {
  it('terminates a stalled tokenizer at the deadline while the event loop stays responsive', async () => {
    const workers: Worker[] = [];
    const pool = createHighlightWorkerPool({
      createWorker: () => {
        const worker = workers.length === 0 ? evalWorker(stalledSource) : evalWorker(echoSource);
        workers.push(worker);
        return worker;
      },
      deadlineMs: SYNTAX_HIGHLIGHT_DEADLINE_MS,
      maxQueuedJobs: SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS,
    });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const started = performance.now();
    const stalled = pool.run(job('a', 'b'));
    const firstExit = new Promise((resolve) => workers[0]!.once('exit', resolve));
    // A queued page render ends with the stalled one.
    const queued = pool.run(job('c'));

    expect(await stalled).toEqual([timeout, timeout]);
    expect(await queued).toEqual([timeout]);
    const elapsed = performance.now() - started;
    delay.disable();
    expect(elapsed).toBeGreaterThanOrEqual(SYNTAX_HIGHLIGHT_DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(SYNTAX_HIGHLIGHT_DEADLINE_MS + 3_000);
    // The request thread kept serving its event loop while the worker spun.
    expect(delay.max / 1e6).toBeLessThan(500);
    await firstExit;
    expect(logged).toHaveBeenCalledWith(
      'Syntax highlighting took longer than 2000 ms; the worker was stopped',
    );

    // The next job starts a new worker and succeeds.
    expect(await pool.run(job('d'))).toEqual([tokens('d')]);
    expect(workers).toHaveLength(2);
    await workers[1]!.terminate();
  }, 20_000);

  it('ends many lines that each stay under the per-line limit at the aggregate deadline', async () => {
    const worker = evalWorker(slowLinesSource);
    const pool = createHighlightWorkerPool({
      createWorker: () => worker,
      deadlineMs: 300,
      maxQueuedJobs: SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS,
    });
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    const started = performance.now();
    expect(await pool.run(job('a'))).toEqual([timeout]);
    expect(performance.now() - started).toBeLessThan(5_000);
    await exited;
  }, 20_000);

  it('counts the wait in the queue: a job behind a slow one shares its fate', async () => {
    vi.useFakeTimers();
    const { pool, workers } = fakePool({ deadlineMs: 1_000 });
    const first = pool.run(job('a'));
    vi.advanceTimersByTime(600);
    const second = pool.run(job('b'));
    vi.advanceTimersByTime(400);
    expect(await first).toEqual([timeout]);
    expect(await second).toEqual([timeout]);
    expect(workers[0]!.terminated).toBe(true);
  });
});

describe('createHighlightWorkerPool late answers (Codex review round 1)', () => {
  it('treats an answer that arrives after the deadline as a timeout, even before the timer ran', async () => {
    const { pool, workers } = fakePool({ deadlineMs: 50 });
    const late = pool.run(job('a'));
    const queued = pool.run(job('b'));
    // A busy request thread: the deadline passes while no timer callback can run.
    const end = performance.now() + 80;
    while (performance.now() < end) {
      // spin
    }
    workers[0]!.emit('message', { results: [tokens('a')] });
    expect(await late).toEqual([timeout]);
    expect(await queued).toEqual([timeout]);
    expect(workers[0]!.terminated).toBe(true);
  });
});

describe('createHighlightWorkerPool queue', () => {
  it('runs one job at a time, in submission order, on one worker', async () => {
    const { pool, workers } = fakePool();
    const first = pool.run(job('a'));
    const second = pool.run(job('b'));
    expect(workers).toHaveLength(1);
    expect(workers[0]!.unref).toHaveBeenCalledOnce();
    expect(workers[0]!.posted).toHaveLength(1);

    workers[0]!.emit('message', { results: [tokens('a')] });
    expect(await first).toEqual([tokens('a')]);
    expect(workers[0]!.posted).toHaveLength(2);
    workers[0]!.emit('message', { results: [tokens('b')] });
    expect(await second).toEqual([tokens('b')]);
    expect(workers).toHaveLength(1);
  });

  it(`does not highlight a job beyond ${SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS} waiting ones`, async () => {
    const { pool, workers } = fakePool();
    const running = pool.run(job('running'));
    const waiting = Array.from({ length: SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS }, (_, index) =>
      pool.run(job(`waiting ${index}`)),
    );
    expect(await pool.run(job('one too many', 'two'))).toEqual([timeout, timeout]);

    workers[0]!.emit('message', { results: [tokens('running')] });
    expect(await running).toEqual([tokens('running')]);
    for (const [index, pending] of waiting.entries()) {
      workers[0]!.emit('message', { results: [tokens(`waiting ${index}`)] });
      expect(await pending).toEqual([tokens(`waiting ${index}`)]);
    }
  });

  it('with a full queue of real threads, the stalled worker frees every page at the deadline', async () => {
    const pool = createHighlightWorkerPool({
      createWorker: () => evalWorker(stalledSource),
      deadlineMs: 300,
      maxQueuedJobs: 2,
    });
    const pages = [pool.run(job('a')), pool.run(job('b')), pool.run(job('c'))];
    expect(await pool.run(job('d'))).toEqual([timeout]);
    expect(await Promise.all(pages)).toEqual([[timeout], [timeout], [timeout]]);
  }, 20_000);

  it('ignores a message from a stopped worker and one without a running job', async () => {
    vi.useFakeTimers();
    const { pool, workers } = fakePool({ deadlineMs: 1_000 });
    const first = pool.run(job('a'));
    vi.advanceTimersByTime(1_000);
    expect(await first).toEqual([timeout]);
    const old = workers[0]!;
    old.emit('message', { results: [tokens('late')] });
    old.emit('error', new Error('late'));
    old.emit('exit', 1);

    const second = pool.run(job('b'));
    const current = workers[1]!;
    current.emit('message', { results: [tokens('b')] });
    expect(await second).toEqual([tokens('b')]);
    current.emit('message', { results: [tokens('unasked')] });
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('createHighlightWorkerPool failures (FR-123-74)', () => {
  it('ends the jobs of a worker that throws as failed and replaces it', async () => {
    const { pool, workers } = fakePool();
    const first = pool.run(job('a'));
    const second = pool.run(job('b'));
    workers[0]!.emit('error', new TypeError('broken'));
    expect(await first).toEqual([failed]);
    expect(await second).toEqual([failed]);
    expect(workers[0]!.terminated).toBe(true);
    expect(logged).toHaveBeenCalledWith('Syntax highlighting worker failed: TypeError');

    const third = pool.run(job('c'));
    expect(workers).toHaveLength(2);
    workers[1]!.emit('message', { results: [tokens('c')] });
    expect(await third).toEqual([tokens('c')]);
  });

  it('replaces an idle worker that failed, naming a thrown value that is not an Error', async () => {
    const { pool, workers } = fakePool();
    const first = pool.run(job('a'));
    workers[0]!.emit('message', { results: [tokens('a')] });
    await first;
    workers[0]!.emit('error', 'nope');
    expect(logged).toHaveBeenCalledWith('Syntax highlighting worker failed: unknown error');
    void pool.run(job('b'));
    expect(workers).toHaveLength(2);
  });

  it('ends the jobs of a worker that exits as failed', async () => {
    const { pool, workers } = fakePool();
    const first = pool.run(job('a'));
    workers[0]!.emit('exit', 1);
    expect(await first).toEqual([failed]);
    expect(logged).toHaveBeenCalledWith('Syntax highlighting worker exited with code 1');
  });

  it('ends the job of a real worker that crashes as failed', async () => {
    const pool = createHighlightWorkerPool({
      createWorker: () =>
        evalWorker(`parentPort.on('message', () => { throw new RangeError('x'); });`),
      deadlineMs: 10_000,
      maxQueuedJobs: SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS,
    });
    expect(await pool.run(job('a'))).toEqual([failed]);
    expect(logged).toHaveBeenCalledWith('Syntax highlighting worker failed: RangeError');
  }, 20_000);

  it('does not memoise a worker that cannot start: the next job tries again', async () => {
    let attempts = 0;
    const worker = new FakeWorker();
    const pool = createHighlightWorkerPool({
      createWorker: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('no threads');
        return worker as unknown as Worker;
      },
      deadlineMs: 60_000,
      maxQueuedJobs: SYNTAX_HIGHLIGHT_MAX_QUEUED_JOBS,
    });
    expect(await pool.run(job('a'))).toEqual([failed]);
    expect(logged).toHaveBeenCalledWith('Syntax highlighting worker did not start: Error');
    const second = pool.run(job('b'));
    worker.emit('message', { results: [tokens('b')] });
    expect(await second).toEqual([tokens('b')]);
    expect(attempts).toBe(2);
  });
});
