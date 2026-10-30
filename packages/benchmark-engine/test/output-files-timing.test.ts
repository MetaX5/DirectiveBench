import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, pinWorkspace } from '@directivebench/agent-adapters';
import { buildManifest } from '../src/files';
import {
  captureOutputFiles,
  OUTPUT_FILE_MAX_BYTES,
  OUTPUT_RUN_MAX_BYTES,
} from '../src/output-files';
import { collectGarbage, useTempDirs } from './helpers';

/**
 * NFR-123-01: capture adds at most 1 s per agent run for 10 generated text files of 1 MiB each.
 *
 * A wall-clock bound is what a loaded 2-core runner cannot promise (lesson 2026-10-21 "Timing
 * tests must survive a loaded CI runner"), so the test measures the CPU time of the whole
 * process (reads and hashing run on libuv's thread pool, which the thread clock does not see)
 * and keeps the fastest of a few runs: other processes on the shared cores cannot stretch it.
 * The capture takes the path with the most work, an `agent-error` or `timeout` run without a
 * measurement manifest (it builds its own), with the Claude Code adapter's known-key search.
 * The bound is the target itself: the capture measures well under a tenth of it on a developer
 * machine and under `taskset -c 0,1` with the full suite running (see the run log
 * 2026-10-30-spec-123-close-acceptance), while a quadratic step over 10 MiB would take minutes.
 */

const tmp = useTempDirs();

/** NFR-123-01's target, in milliseconds of process CPU time per agent run. */
const CAPTURE_TIME_TARGET_MS = 1_000;
/** Number of generated files, each `OUTPUT_FILE_MAX_BYTES` (1 MiB) long. */
const FILE_COUNT = 10;
/** Captures measured; the fastest one counts. */
const TIMING_ROUNDS = 3;
/** Writing 10 MiB and capturing it four times on a loaded 2-core runner. */
const CAPTURE_TIMING_TEST_TIMEOUT_MS = 60_000;

/** 1 MiB of text lines that look like a log, with words that resemble but are not secrets. */
function generatedText(seed: number): string {
  const line = (n: number) =>
    `${String(n).padStart(7, '0')} file ${seed}: sk task ghp key=value token AKIA lorem ipsum\n`;
  let text = '';
  for (let n = 0; text.length < OUTPUT_FILE_MAX_BYTES; n += 1) text += line(n);
  return text.slice(0, OUTPUT_FILE_MAX_BYTES);
}

describe('captureOutputFiles: time (NFR-123-01)', () => {
  it(
    'captures 10 generated 1 MiB text files within the 1 s target of CPU time',
    async () => {
      expect(FILE_COUNT * OUTPUT_FILE_MAX_BYTES).toBe(OUTPUT_RUN_MAX_BYTES);
      const dir = join(tmp('capture-timing'), 'workspace');
      mkdirSync(dir);
      writeFileSync(join(dir, 'README.md'), 'Brief.\n');
      const pin = await pinWorkspace(dir);
      const before = await buildManifest(dir);
      for (let index = 0; index < FILE_COUNT; index += 1) {
        writeFileSync(join(dir, `out-${index}.log`), generatedText(index));
      }
      const adapter = new ClaudeCodeAdapter(
        { authMode: 'api-key' },
        { ANTHROPIC_API_KEY: 'custom-known-secret-value-42', PATH: '' },
      );
      const capture = () =>
        captureOutputFiles({ workspace: pin, before, measured: null, installedPaths: [], adapter });

      // One discarded run warms up the JIT and the page cache; then a collection, so the
      // garbage of building the inputs cannot land in a measurement.
      const warmUp = await capture();
      if (!warmUp.ok) throw new Error(`capture failed: ${warmUp.reason}`);
      expect(warmUp.capture.files).toHaveLength(FILE_COUNT);
      expect(warmUp.capture.files.every((file) => file.kept === 'full')).toBe(true);
      await collectGarbage();

      let fastest = Number.POSITIVE_INFINITY;
      for (let round = 0; round < TIMING_ROUNDS; round += 1) {
        const started = process.cpuUsage();
        const outcome = await capture();
        const used = process.cpuUsage(started);
        expect(outcome.ok).toBe(true);
        fastest = Math.min(fastest, (used.user + used.system) / 1000);
      }
      expect(fastest).toBeLessThan(CAPTURE_TIME_TARGET_MS);
    },
    CAPTURE_TIMING_TEST_TIMEOUT_MS,
  );
});
