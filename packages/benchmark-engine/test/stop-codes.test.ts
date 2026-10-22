import { describe, expect, it } from 'vitest';
import { assertNotStopped, BenchmarkStoppedError, STOP_CODES } from '../src/agent-conditions';

const record = (errorCode: string | null, error: string | null = 'detail') => ({
  caseId: 'c',
  variant: 'candidate' as const,
  repetition: 2,
  executionStatus: 'agent-error' as const,
  score: null,
  passed: null,
  error,
  errorCode,
  warnings: [],
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
    for (const code of ['output-limit', 'spawn-failed', 'agent-failed', 'provider-error']) {
      expect(STOP_CODES).not.toContain(code);
    }
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
