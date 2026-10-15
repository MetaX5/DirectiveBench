import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '@directivebench/database';
import { getBenchmarkRunDetail } from '@directivebench/database';
import type * as RunnerModule from '@directivebench/runner';
import type { JobExecutionResult } from '@directivebench/runner';
import { demoCommand } from '../src/commands';
import { CliError, ExitCode } from '../src/runtime';

// The real demo is exercised in commands.test.ts; here the runner outcome and the stored run are
// replaced to reach the failure and formatting branches that a healthy mock run never produces.
const runner = vi.hoisted(() => ({ results: [] as JobExecutionResult[] }));
vi.mock('@directivebench/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof RunnerModule>()),
  LocalRunner: class {
    runUntilIdle(): Promise<JobExecutionResult[]> {
      return Promise.resolve(runner.results);
    }
  },
}));
vi.mock('@directivebench/database', async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  getBenchmarkRunDetail: vi.fn(),
}));

let dataDir: string;
let output: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'db-cli-demo-'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    output.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getBenchmarkRunDetail).mockReset();
  rmSync(dataDir, { recursive: true, force: true });
});

const completed: JobExecutionResult = {
  jobId: 'job_1',
  status: 'completed',
  benchmarkRunId: 'brun_1',
  error: null,
};

async function demoError(): Promise<CliError> {
  const error = await demoCommand({ dataDir }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

describe('demo outcomes', () => {
  it('fails when no job was executed', async () => {
    runner.results = [];
    const error = await demoError();
    expect(error.message).toBe('Demo benchmark did not complete: no job executed');
    expect(error.exitCode).toBe(ExitCode.CheckFailed);
  });

  it('reports the error of the last job when it did not complete', async () => {
    runner.results = [
      completed,
      { jobId: 'job_2', status: 'failed', benchmarkRunId: null, error: 'fixture missing' },
    ];
    expect((await demoError()).message).toBe('Demo benchmark did not complete: fixture missing');
  });

  it('fails when a completed job has no benchmark run', async () => {
    runner.results = [{ ...completed, benchmarkRunId: null }];
    expect((await demoError()).message).toBe('Demo benchmark did not complete: no job executed');
  });

  it('fails when the stored run cannot be found', async () => {
    runner.results = [completed];
    vi.mocked(getBenchmarkRunDetail).mockResolvedValue(null);
    const error = await demoError();
    expect(error.message).toBe('Demo run has no summary');
    expect(error.exitCode).toBe(ExitCode.CheckFailed);
    expect(getBenchmarkRunDetail).toHaveBeenCalledWith(expect.anything(), 'brun_1');
  });

  it('prints missing scores as dashes and fails when the candidate did not improve', async () => {
    runner.results = [completed];
    const summary = {
      baseline: { meanScore: null, passRate: undefined },
      candidate: { meanScore: 0.5, passRate: 0.25 },
      delta: -0.125,
      verdict: 'regressed',
      confidence: { level: 'low' },
    };
    vi.mocked(getBenchmarkRunDetail).mockResolvedValue({ run: { summary } } as unknown as Awaited<
      ReturnType<typeof getBenchmarkRunDetail>
    >); // only `run.summary` is read by the demo command

    expect(await demoCommand({ dataDir })).toBe(ExitCode.CheckFailed);
    expect(output).toContain('  Baseline (RED):    score —, pass rate —');
    expect(output).toContain('  Candidate (GREEN): score 50.0%, pass rate 25.0%');
    expect(output).toContain('  Delta:             -12.5 points');
    expect(output).toContain('  Verdict:           regressed (confidence: low)');
  });
});
