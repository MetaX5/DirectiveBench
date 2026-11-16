import { displayStatus, type DisplayStatus } from '@directivebench/benchmark-engine/scoring';

/** Derives the display status from a stored run (verdict + summary.candidateOutcome). */
export function runDisplayStatus(
  run: { verdict: string | null; status: string; summary: unknown } | null,
): DisplayStatus {
  if (!run) return 'not-tested';
  if (run.status === 'error') return 'error';
  if (run.status !== 'completed') return 'not-tested';
  const outcome = (run.summary as { candidateOutcome?: string } | null)?.candidateOutcome;
  return displayStatus(run.verdict, outcome);
}

/** The text of a display status, as its StatusBadge shows it (and accessible names repeat it). */
export const DISPLAY_STATUS_LABELS: Record<DisplayStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  regression: 'Regression',
  unstable: 'Unstable',
  error: 'Error',
  'not-tested': 'Not tested',
  'not-comparable': 'Not comparable',
};
