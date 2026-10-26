/**
 * The one helper for linear-time assertions in every package's tests (issue #114, lesson
 * 2026-10-21 "Timing tests must survive a loaded CI runner").
 *
 * A test builds its input at two sizes, `size ÷ LINEAR_SIZE_STEP` and `size`, and measures the
 * code under test and a linear baseline on both. The result is the growth of the code divided by
 * the growth of the baseline: about 1 for linear code, √32 ≈ 5.7 for N^1.5 code and 32 for
 * quadratic code, whatever the machine. Raw growth depends on the machine: once inputs outgrow the CPU
 * caches even `split` grows ~16× for 8× the input, and a loaded 2-core runner slows everything.
 *
 * Measurement rules, from CI failures and their reproduction under `taskset -c 0,1` with load:
 * - a full garbage collection after building the inputs, so their garbage cannot land inside a
 *   measurement;
 * - samples measure CPU time, not wall-clock time, so other processes on the shared cores cannot
 *   stretch a sample (they did, unevenly, by whole scheduler time slices): the test thread's for
 *   synchronous code, the whole process's for asynchronous code, whose work may run on libuv's
 *   thread pool;
 * - every sample repeats the call until it has used `MIN_SAMPLE_MS` of CPU time, so timer
 *   resolution cannot dominate a small input;
 * - one discarded warm-up round lets the JIT optimise the code first;
 * - the four series (code and baseline, small and large) are sampled in interleaved rounds and
 *   each keeps its fastest sample, so a disturbance slows a sample down but cannot fake growth;
 * - sizes are the caller's, kept small enough for 2 cores, and the test carries
 *   `LINEAR_TIME_TEST_TIMEOUT_MS` instead of vitest's 5 s default.
 *
 * It lives at the repository root, next to `vitest.shared.ts`, and is imported by relative path
 * from test files only: no package depends on another package's tests and nothing ships it.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect } from 'vitest';

/**
 * Factor between the small and the large input. 32 rather than 8 so that N^1.5 growth (√8 ≈ 2.8
 * at 8×) clears the bound too (Codex review of PR #121); the large inputs keep the sizes the tests
 * used before, so only the small ones shrank.
 */
export const LINEAR_SIZE_STEP = 32;

/**
 * Bound on the normalised growth. Measured under `taskset -c 0,1` with two `yes` processes and
 * four parallel vitest runs: every linear shape at most 1.3 (bounded work, such as a scan that
 * stops at its limit, near 0), an N^1.5 control 5.6–5.9, a quadratic control 30–36 and work on
 * the thread pool growing with size² 31–36.
 */
export const MAX_LINEAR_RATIO = 3.5;

/** Fastest of this many interleaved samples per series. */
export const LINEAR_TIME_ROUNDS = 3;

/** Minimum CPU time of one sample; short calls are repeated until it is reached. */
export const MIN_SAMPLE_MS = 20;

/** Per-test timeout for linear-time tests on a loaded 2-core CI runner. */
export const LINEAR_TIME_TEST_TIMEOUT_MS = 60_000;

/**
 * Runs a full garbage collection. Two passes with a macrotask between them: WeakRef targets
 * survive until the end of the job that last dereferenced them, and FinalizationRegistry
 * callbacks run after a collection.
 */
export async function collectGarbage(): Promise<void> {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  await new Promise((resolve) => setImmediate(resolve));
  gc();
}

/**
 * A linear baseline for text inputs: one pass over every character, then split into lines and
 * collapse whitespace. The pass has almost no fixed cost per call, so the baseline grows with
 * the input even when the small input takes a microsecond: split and collapse alone cost about a
 * microsecond per call whatever the input, grew only 7.6× for 31× a short input of backtick runs
 * and made a linear parser measure 3.6. Split and collapse stay because they allocate like a
 * parser: with the pass alone, an allocation-heavy linear scan of a 3.8 MB line measured 3.4.
 * It returns the hash, so the JIT cannot drop the pass as dead code.
 */
export function textBaseline(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  text.split('\n');
  text.replace(/\s+/g, ' ');
  return hash;
}

export interface LinearTimeCase<T> {
  /** Builds the input for a size; called once per size, outside the measurements. */
  build: (size: number) => T | Promise<T>;
  /** The code under test; called repeatedly on the same input, so it must not consume it. */
  run: (input: T) => unknown;
  /** Code known to be linear in the input, measured on the same inputs (`textBaseline` for text). */
  baseline: (input: T) => unknown;
  /** The large size; the small one is `size ÷ LINEAR_SIZE_STEP`. Keep it small enough for 2 cores. */
  size: number;
}

type Clock = () => number;

/**
 * CPU time of the calling thread, in milliseconds (user and system), for synchronous code.
 * Process-wide CPU time also bills V8's helper threads (concurrent marking and sweeping, background
 * compilation), whose work follows the size of vitest's heap rather than the input, and inflated
 * samples of large inputs. `process.threadCpuUsage` exists from Node.js 23.9 (CI runs 24); older
 * versions fall back to the process-wide figure.
 */
const threadCpuMs: Clock =
  typeof process.threadCpuUsage === 'function'
    ? () => cpuMs(process.threadCpuUsage())
    : () => cpuMs(process.cpuUsage());

/**
 * CPU time of the whole process, in milliseconds, for asynchronous code: file-system work runs on
 * libuv's thread pool, which the thread clock does not see (Codex review round 2 of PR #121: a
 * read of size² bytes measured 1.1 against size bytes with it).
 */
const processCpuMs: Clock = () => cpuMs(process.cpuUsage());

function cpuMs({ user, system }: NodeJS.CpuUsage): number {
  return (user + system) / 1000;
}

/**
 * CPU milliseconds per call of `fn(input)`, measured over at least `MIN_SAMPLE_MS` of CPU time.
 * CPU time, not wall-clock time: on a loaded runner the scheduler takes the core away for whole
 * time slices, which inflated wall-clock samples unevenly (a quadratic function measured ~2 under
 * load), while the CPU time a call uses barely changes. Calls run in doubling batches and the
 * clock is read once per batch: reading it after every call (a system call of about a
 * microsecond) inflated the baseline on small inputs, where one call takes about as long.
 */
async function sample<T>(clock: Clock, fn: (input: T) => unknown, input: T): Promise<number> {
  let calls = 0;
  let batch = 1;
  const started = clock();
  let elapsed: number;
  do {
    for (let call = 0; call < batch; call += 1) {
      // Await only real promises: an `await` per synchronous call would add a constant cost
      // that makes small inputs look slower and hides growth.
      const result = fn(input);
      if (result instanceof Promise) await result;
    }
    calls += batch;
    batch *= 2;
    elapsed = clock() - started;
  } while (elapsed < MIN_SAMPLE_MS);
  return elapsed / calls;
}

/** Growth of `run` from `size ÷ LINEAR_SIZE_STEP` to `size`, divided by the baseline's growth. */
export async function linearTimeRatio<T>(test: LinearTimeCase<T>): Promise<number> {
  // A fractional small size would reach the builder (`'x'.repeat` truncates it, `new Array` throws).
  if (!Number.isInteger(test.size / LINEAR_SIZE_STEP)) {
    throw new Error(
      `linearTimeRatio: size ${test.size} is not a multiple of LINEAR_SIZE_STEP (${LINEAR_SIZE_STEP})`,
    );
  }
  const small = await test.build(test.size / LINEAR_SIZE_STEP);
  const large = await test.build(test.size);
  // One collection before measuring, not one per sample: the garbage of building the inputs must
  // not land in a sample, and a forced collection before every sample made the samples slower
  // and noisier (a quadratic function measured ~3).
  await collectGarbage();
  const series = [
    [test.run, small],
    [test.run, large],
    [test.baseline, small],
    [test.baseline, large],
  ] as const;
  // Asynchronous code may do its work off the test thread, so when `run` or its baseline is
  // asynchronous both are measured with the process clock; otherwise with the thread clock. Both
  // are probed: an asynchronous baseline measured with the thread clock looked constant (review
  // of PR #121).
  const probes = [test.run(small), test.baseline(small)];
  const clock = probes.some((probe) => probe instanceof Promise) ? processCpuMs : threadCpuMs;
  await Promise.all(probes);
  // One warm-up round, discarded: the first calls run before the JIT has optimised the code,
  // which made the first ratio of a process unreliable (a quadratic function measured ~2.5).
  for (const [fn, input] of series) await sample(clock, fn, input);
  const fastest = series.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < LINEAR_TIME_ROUNDS; round += 1) {
    for (const [index, [fn, input]] of series.entries()) {
      fastest[index] = Math.min(fastest[index] as number, await sample(clock, fn, input));
    }
  }
  const [runSmall, runLarge, baseSmall, baseLarge] = fastest as [number, number, number, number];
  return runLarge / runSmall / (baseLarge / baseSmall);
}

/** Asserts that `run` grows like the linear baseline (normalised ratio below `MAX_LINEAR_RATIO`). */
export async function expectLinearTime<T>(test: LinearTimeCase<T>, label?: string): Promise<void> {
  expect(await linearTimeRatio(test), label).toBeLessThan(MAX_LINEAR_RATIO);
}
