import type { ViteUserConfig } from 'vitest/config';

type CoverageOptions = NonNullable<NonNullable<ViteUserConfig['test']>['coverage']>;

/**
 * Coverage settings shared by every package. Logic must stay at 100% lines, branches, functions
 * and statements (AGENTS.md §2, SPEC-012 §3); `pnpm test` fails below the threshold.
 */
export function fullCoverage(include: string[], exclude: string[] = []): CoverageOptions {
  return {
    enabled: true,
    provider: 'v8',
    include,
    exclude,
    reporter: ['text-summary', 'text', 'json-summary'],
    reportOnFailure: true,
    thresholds: { 100: true },
  };
}
