import { describe, expect, it } from 'vitest';
import { assertNotStopped, BenchmarkStoppedError, isStopCode, STOP_CODES } from '../src/stop';

const record = (errorCode: string | null, error: string | null = 'detail') => ({
  caseId: 'c',
  variant: 'candidate' as const,
  repetition: 2,
  executionStatus: 'agent-error' as const,
  error,
  errorCode,
});

describe('FR-118-15 stop codes', () => {
  it('lists the systematic codes of SPEC-118 FR-118-15', () => {
    expect(STOP_CODES).toEqual([
      'auth-missing',
      'auth-expired',
      'auth-invalid',
      'billing',
      'rate-limited',
      'auth-mismatch',
      'artifact-not-loaded',
      'workspace-contains-claude-config',
      'workspace-imports-outside',
      'workspace-scan-limit',
      'workspace-replaced',
      'stray-processes',
    ]);
    expect(isStopCode('output-limit')).toBe(false);
    expect(isStopCode('spawn-failed')).toBe(false);
    expect(isStopCode('rate-limited')).toBe(true);
    expect(isStopCode('agent-failed')).toBe(false);
    expect(isStopCode(null)).toBe(false);
  });

  it('lets other runs pass and stops on a stop code with the run named', () => {
    expect(() => assertNotStopped(record(null))).not.toThrow();
    expect(() => assertNotStopped(record('output-limit'))).not.toThrow();
    let stopped: unknown;
    try {
      assertNotStopped(record('auth-expired', null));
    } catch (error) {
      stopped = error;
    }
    expect(stopped).toBeInstanceOf(BenchmarkStoppedError);
    expect(stopped).toMatchObject({
      name: 'BenchmarkStoppedError',
      code: 'auth-expired',
      message:
        'Stopped after case c, candidate repetition 2 (auth-expired): no detail. No further agent runs were started.',
    });
  });
});
