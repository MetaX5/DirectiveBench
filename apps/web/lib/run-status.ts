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
