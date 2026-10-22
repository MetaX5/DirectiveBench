/**
 * The one helper for linear-time assertions in every package's tests (issue #114, lesson
 * 2026-10-21 "Timing tests must survive a loaded CI runner").
 *
 * A test builds its input at two sizes, `size` and `size × LINEAR_SIZE_STEP`, and measures the
 * code under test and a linear baseline on both. The result is the growth of the code divided by
 * the growth of the baseline: about 1 for linear code, about `LINEAR_SIZE_STEP` (8) for quadratic
 * code, whatever the machine. Raw growth depends on the machine: once inputs outgrow the CPU
 * caches even `split` grows ~16× for 8× the input, and a loaded 2-core runner slows everything.
 *
 * Measurement rules, from CI failures and their reproduction under `taskset -c 0,1` with load:
 * - a full garbage collection after building the inputs, so their garbage cannot land inside a
 *   measurement;
 * - samples measure the process's CPU time, not wall-clock time, so other processes on the
 *   shared cores cannot stretch a sample (they did, unevenly, by whole scheduler time slices);
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

/** Factor between the small and the large input. */
export const LINEAR_SIZE_STEP = 8;

/**
 * Bound on the normalised growth: linear code measures ~1 (up to ~2 under load), quadratic code
 * ~8 and an N^1.5 scan ~2.8 × noise, so the bound sits between linear and quadratic.
 */
export const MAX_LINEAR_RATIO = 4;

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

/** A linear baseline for text inputs: split into lines and collapse whitespace. */
export function textBaseline(text: string): void {
  text.split('\n');
  text.replace(/\s+/g, ' ');
}

export interface LinearTimeCase<T> {
  /** Builds the input for a size; called once per size, outside the measurements. */
  build: (size: number) => T | Promise<T>;
  /** The code under test; called repeatedly on the same input, so it must not consume it. */
  run: (input: T) => unknown;
  /** Code known to be linear in the input, measured on the same inputs (`textBaseline` for text). */
  baseline: (input: T) => unknown;
  /** The small size; the large one is `size × LINEAR_SIZE_STEP`. */
  size: number;
}

/** CPU time this process has used, in milliseconds (user and system, all threads). */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/**
 * CPU milliseconds per call of `fn(input)`, measured over at least `MIN_SAMPLE_MS` of CPU time.
 * CPU time, not wall-clock time: on a loaded runner the scheduler takes the core away for whole
 * time slices, which inflated wall-clock samples unevenly (a quadratic function measured ~2 under
 * load), while the CPU time a call uses barely changes.
 */
async function sample<T>(fn: (input: T) => unknown, input: T): Promise<number> {
  let calls = 0;
  const started = cpuMs();
  let elapsed: number;
  do {
    // Await only real promises: an `await` per synchronous call would add a constant cost that
    // makes small inputs look slower and hides growth.
    const result = fn(input);
    if (result instanceof Promise) await result;
    calls += 1;
    elapsed = cpuMs() - started;
  } while (elapsed < MIN_SAMPLE_MS);
  return elapsed / calls;
}

/** Growth of `run` from `size` to `size × LINEAR_SIZE_STEP`, divided by the baseline's growth. */
export async function linearTimeRatio<T>(test: LinearTimeCase<T>): Promise<number> {
  const small = await test.build(test.size);
  const large = await test.build(test.size * LINEAR_SIZE_STEP);
  // One collection before measuring, not one per sample: the garbage of building the inputs must
  // not land in a sample, but a forced collection leaves background sweeping that counts towards
  // the process's CPU time and inflated the next short sample (a quadratic function measured ~3).
  await collectGarbage();
  const series = [
    [test.run, small],
    [test.run, large],
    [test.baseline, small],
    [test.baseline, large],
  ] as const;
  // One warm-up round, discarded: the first calls run before the JIT has optimised the code,
  // which made the first ratio of a process unreliable (a quadratic function measured ~2.5).
  for (const [fn, input] of series) await sample(fn, input);
  const fastest = series.map(() => Number.POSITIVE_INFINITY);
  for (let round = 0; round < LINEAR_TIME_ROUNDS; round += 1) {
    for (const [index, [fn, input]] of series.entries()) {
      fastest[index] = Math.min(fastest[index] as number, await sample(fn, input));
    }
  }
  const [runSmall, runLarge, baseSmall, baseLarge] = fastest as [number, number, number, number];
  return runLarge / runSmall / (baseLarge / baseSmall);
}

/** Asserts that `run` grows no faster than the linear baseline (normalised ratio below 4). */
export async function expectLinearTime<T>(test: LinearTimeCase<T>, label?: string): Promise<void> {
  expect(await linearTimeRatio(test), label).toBeLessThan(MAX_LINEAR_RATIO);
}
