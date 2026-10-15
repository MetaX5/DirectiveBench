import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunnerLogger } from '../src/logger';

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function captureStderr() {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

describe('createRunnerLogger', () => {
  it('appends redacted JSON lines and prints a readable line to stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-cli-logger-'));
    tempDirs.push(dir);
    const logFile = join(dir, 'runner.log');
    const stderr = captureStderr();
    let id = 'runner-1';
    const logger = createRunnerLogger(logFile, () => id);

    logger.info('Job job_1 acquired', { event: 'acquired', jobId: 'job_1' });
    id = 'runner-2';
    logger.error('token sk-ant-abcdefghijklmnopqrstuvwxyz0123 leaked');

    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toMatchObject({
      level: 'info',
      runnerId: 'runner-1',
      msg: 'Job job_1 acquired',
      event: 'acquired',
      jobId: 'job_1',
    });
    expect(Date.parse(String(first?.ts))).not.toBeNaN();
    expect(second).toMatchObject({ level: 'error', runnerId: 'runner-2' });
    expect(String(second?.msg)).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(stderr[0]).toBe('[runner] Job job_1 acquired\n');
    expect(stderr[1]).toMatch(/^\[runner\] token .* leaked\n$/);
    expect(stderr[1]).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
  });

  it('keeps logging to stderr when the log file cannot be written', () => {
    const stderr = captureStderr();
    const logger = createRunnerLogger(
      join(tmpdir(), 'db-cli-missing-dir', 'x', 'runner.log'),
      () => 'r',
    );
    expect(() => logger.info('still visible')).not.toThrow();
    expect(stderr).toEqual(['[runner] still visible\n']);
  });
});
