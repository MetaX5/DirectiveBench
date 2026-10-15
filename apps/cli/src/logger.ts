import { appendFileSync } from 'node:fs';
import { redactSecrets } from '@directivebench/core';
import type { RunnerLogFields, RunnerLogger } from '@directivebench/runner';

/**
 * Runner logger for `serve`: every event is appended as a redacted JSON line to
 * `<dataDir>/logs/runner.log` and printed to stderr in a human-readable form (FR-114-15).
 */
export function createRunnerLogger(logFile: string, runnerId: () => string): RunnerLogger {
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
    process.stderr.write(`[runner] ${redactSecrets(message)}\n`);
  };
  return {
    info: (message, fields) => write('info', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
