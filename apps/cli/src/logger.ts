import { appendFileSync } from 'node:fs';
import { redactSecrets } from '@directivebench/core';
import type { RunnerLogFields, RunnerLogger } from '@directivebench/runner';

/**
 * Runner logger for `benchmark run` and `demo`: every event is appended as a redacted JSON line
 * to `<dataDir>/logs/runner.log` (mode 0600) and nothing is printed, so the commands' terminal
 * output stays as it was. The log keeps the raw error of a job that failed unexpectedly
 * (`job-error`, FR-114-10/15, issue #193).
 */
export function createFileRunnerLogger(logFile: string, runnerId: () => string): RunnerLogger {
  const write = (level: 'info' | 'error', message: string, fields: RunnerLogFields = {}) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      runnerId: runnerId(),
      msg: message,
      ...fields,
    };
    try {
      appendFileSync(logFile, `${redactSecrets(JSON.stringify(entry))}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break job execution.
    }
  };
  return {
    info: (message, fields) => write('info', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

/**
 * Runner logger for `serve`: every event is written to `<dataDir>/logs/runner.log` as by
 * {@link createFileRunnerLogger} and printed to stderr in a human-readable form (FR-114-15).
 */
export function createRunnerLogger(logFile: string, runnerId: () => string): RunnerLogger {
  const file = createFileRunnerLogger(logFile, runnerId);
  const print = (message: string) => process.stderr.write(`[runner] ${redactSecrets(message)}\n`);
  return {
    info: (message, fields) => {
      file.info(message, fields);
      print(message);
    },
    error: (message, fields) => {
      file.error(message, fields);
      print(message);
    },
  };
}
