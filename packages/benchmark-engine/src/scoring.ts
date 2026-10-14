import type { BenchmarkDefinition } from './definition';

export type Variant = 'baseline' | 'candidate';
export type ExecutionStatus =
  'completed' | 'agent-error' | 'timeout' | 'cancelled' | 'infrastructure-error';

export interface ScoredAssertion {
  passed: boolean;
  score: number;
  weight: number;
  required: boolean;
}

/**
 * Weighted run score: Σ(weight·score) / Σweight. A run passes when every required assertion
 * passes and the score reaches the pass threshold.
 */
export function scoreRun(
  assertions: readonly ScoredAssertion[],
  passThreshold: number,
): { score: number; passed: boolean } {
  const totalWeight = assertions.reduce((sum, a) => sum + a.weight, 0);
  const score =
    totalWeight === 0
      ? 0
      : assertions.reduce((sum, a) => sum + a.weight * a.score, 0) / totalWeight;
  const rounded = Math.round(score * 1e6) / 1e6;
  const requiredOk = assertions.every((a) => !a.required || a.passed);
  return { score: rounded, passed: requiredOk && rounded >= passThreshold };
}

export interface RunOutcome {
  caseId: string;
  variant: Variant;
  repetition: number;
  executionStatus: ExecutionStatus;
  score: number | null;
  passed: boolean | null;
  durationMs: number;
}

export interface Aggregate {
  totalRuns: number;
  /** Runs that completed and were scored; only these count towards quality. */
  validRuns: number;
  meanScore: number | null;
  /** Population standard deviation of run scores. */
  stdDev: number | null;
  minScore: number | null;
  maxScore: number | null;
  passRate: number | null;
  /** Share of runs that did not complete (reliability, not quality). */
  errorRate: number;
  meanDurationMs: number | null;
}

export interface CaseSummary {
  caseId: string;
  baseline: Aggregate;
  candidate: Aggregate;
  delta: number | null;
}

export type Verdict =
  'improved' | 'unchanged' | 'regressed' | 'unstable' | 'error' | 'not-comparable';
export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface ScoringSummary {
  baseline: Aggregate;
  candidate: Aggregate;
  delta: number | null;
  passRateDelta: number | null;
  verdict: Verdict;
  candidateOutcome: 'passed' | 'failed' | null;
  confidence: { level: ConfidenceLevel; reason: string };
  deterministicAgent: boolean;
  cases: CaseSummary[];
  scoring: BenchmarkDefinition['scoring'];
  repetitions: number;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

export function aggregate(runs: readonly RunOutcome[]): Aggregate {
  const valid = runs.filter((r) => r.executionStatus === 'completed' && r.score !== null);
  const scores = valid.map((r) => r.score as number);
  const avg = mean(scores);
  const variance =
    avg === null ? null : scores.reduce((s, v) => s + (v - avg) ** 2, 0) / scores.length;
  const durations = mean(runs.map((r) => r.durationMs));
  return {
    totalRuns: runs.length,
    validRuns: valid.length,
    meanScore: avg === null ? null : round(avg),
    stdDev: variance === null ? null : round(Math.sqrt(variance)),
    minScore: scores.length ? Math.min(...scores) : null,
    maxScore: scores.length ? Math.max(...scores) : null,
    passRate: valid.length ? round(valid.filter((r) => r.passed).length / valid.length) : null,
    errorRate: runs.length ? round((runs.length - valid.length) / runs.length) : 0,
    meanDurationMs: durations === null ? null : Math.round(durations),
  };
}

/** Suite-level variant aggregate: equal weight per case, computed from case aggregates. */
function combine(cases: readonly Aggregate[], runs: readonly RunOutcome[]): Aggregate {
  const all = aggregate(runs);
  const scored = cases.filter((c) => c.meanScore !== null);
  const meanScore = mean(scored.map((c) => c.meanScore as number));
  const passRate = mean(scored.map((c) => c.passRate as number));
  return {
    ...all,
    meanScore: meanScore === null ? null : round(meanScore),
    passRate: passRate === null ? null : round(passRate),
    // Spread across cases is not a stability measure; stability is judged per case.
    stdDev: null,
  };
}

export function confidenceFor(
  repetitions: number,
  unstable: boolean,
): { level: ConfidenceLevel; reason: string } {
  if (repetitions < 3) {
    return {
      level: 'low',
      reason: `${repetitions} repetition(s); at least 3 are needed for medium confidence`,
    };
  }
  if (repetitions < 10 || unstable) {
    return {
      level: 'medium',
      reason: unstable
        ? 'results vary between repetitions'
        : `${repetitions} repetitions; at least 10 stable repetitions are needed for high confidence`,
    };
  }
  return { level: 'high', reason: `${repetitions} stable repetitions` };
}

export interface SummarizeOptions {
  caseIds: readonly string[];
  scoring: BenchmarkDefinition['scoring'];
  repetitions: number;
  comparable: boolean;
  deterministicAgent: boolean;
}

/**
 * Turns individual run outcomes into the RED/GREEN comparison. Verdict precedence:
 * error > not-comparable > unstable > regressed > improved > unchanged.
 */
export function summarize(runs: readonly RunOutcome[], options: SummarizeOptions): ScoringSummary {
  const { scoring } = options;
  const cases: CaseSummary[] = options.caseIds.map((caseId) => {
    const forCase = runs.filter((r) => r.caseId === caseId);
    const baseline = aggregate(forCase.filter((r) => r.variant === 'baseline'));
    const candidate = aggregate(forCase.filter((r) => r.variant === 'candidate'));
    const delta =
      baseline.meanScore !== null && candidate.meanScore !== null
        ? round(candidate.meanScore - baseline.meanScore)
        : null;
    return { caseId, baseline, candidate, delta };
  });

  const baseline = combine(
    cases.map((c) => c.baseline),
    runs.filter((r) => r.variant === 'baseline'),
  );
  const candidate = combine(
    cases.map((c) => c.candidate),
    runs.filter((r) => r.variant === 'candidate'),
  );
  const delta =
    baseline.meanScore !== null && candidate.meanScore !== null
      ? round(candidate.meanScore - baseline.meanScore)
      : null;
  const passRateDelta =
    baseline.passRate !== null && candidate.passRate !== null
      ? round(candidate.passRate - baseline.passRate)
      : null;

  const isUnstable = (a: Aggregate) =>
    (a.stdDev !== null && a.stdDev > scoring.stabilityThreshold) ||
    (a.passRate !== null && a.passRate > 0 && a.passRate < 1);
  const unstable = cases.some((c) => isUnstable(c.baseline) || isUnstable(c.candidate));
  const errored = baseline.errorRate > 0.5 || candidate.errorRate > 0.5 || delta === null;

  let verdict: Verdict;
  if (errored) verdict = 'error';
  else if (!options.comparable) verdict = 'not-comparable';
  else if (unstable) verdict = 'unstable';
  else if ((delta as number) <= -scoring.minDelta) verdict = 'regressed';
  else if ((delta as number) >= scoring.minDelta) verdict = 'improved';
  else verdict = 'unchanged';

  const candidateOutcome =
    verdict === 'error'
      ? null
      : cases.every((c) => c.candidate.passRate === 1)
        ? 'passed'
        : 'failed';

  return {
    baseline,
    candidate,
    delta,
    passRateDelta,
    verdict,
    candidateOutcome,
    confidence: confidenceFor(options.repetitions, unstable),
    deterministicAgent: options.deterministicAgent,
    cases,
    scoring,
    repetitions: options.repetitions,
  };
}

export const DISPLAY_STATUSES = [
  'passed',
  'failed',
  'regression',
  'unstable',
  'error',
  'not-tested',
  'not-comparable',
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

/** Maps a stored verdict/outcome to the status shown in listings and detail views. */
export function displayStatus(
  verdict: string | null | undefined,
  candidateOutcome: string | null | undefined,
): DisplayStatus {
  switch (verdict) {
    case undefined:
    case null:
      return 'not-tested';
    case 'error':
      return 'error';
    case 'not-comparable':
      return 'not-comparable';
    case 'unstable':
      return 'unstable';
    case 'regressed':
      return 'regression';
    default:
      return candidateOutcome === 'passed' ? 'passed' : 'failed';
  }
}
