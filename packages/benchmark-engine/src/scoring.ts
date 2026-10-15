import type { BenchmarkDefinition } from './definition';

export type Variant = 'baseline' | 'candidate';
export type ExecutionStatus =
  'completed' | 'agent-error' | 'timeout' | 'cancelled' | 'infrastructure-error';

/** Tolerance for threshold comparisons; scores are stored at full precision (FR-111-06). */
export const SCORE_EPSILON = 1e-9;

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
  const requiredOk = assertions.every((a) => !a.required || a.passed);
  return { score, passed: requiredOk && score >= passThreshold - SCORE_EPSILON };
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
  /** Human-readable explanation of the verdict. */
  reasons: string[];
  candidateOutcome: 'passed' | 'failed' | null;
  confidence: { level: ConfidenceLevel; reason: string };
  deterministicAgent: boolean;
  /** True when the adapter or any assertion is nondeterministic (FR-111-42). */
  nondeterministic: boolean;
  /** False for a single repetition of a nondeterministic run ("not conclusive"). */
  conclusive: boolean;
  cases: CaseSummary[];
  scoring: BenchmarkDefinition['scoring'];
  repetitions: number;
}

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
    meanScore: avg,
    stdDev: variance === null ? null : Math.sqrt(variance),
    minScore: scores.length ? Math.min(...scores) : null,
    maxScore: scores.length ? Math.max(...scores) : null,
    passRate: valid.length ? valid.filter((r) => r.passed).length / valid.length : null,
    errorRate: runs.length ? (runs.length - valid.length) / runs.length : 0,
    meanDurationMs: durations === null ? null : Math.round(durations),
  };
}

/**
 * Suite-level variant aggregate: equal weight per case, computed from case aggregates. If any
 * case has no valid runs, the suite mean is undefined (null) instead of silently skipping the
 * case (FR-111-27).
 */
function combine(cases: readonly Aggregate[], runs: readonly RunOutcome[]): Aggregate {
  const all = aggregate(runs);
  const complete = cases.every((c) => c.meanScore !== null);
  return {
    ...all,
    meanScore: complete ? mean(cases.map((c) => c.meanScore as number)) : null,
    passRate: complete ? mean(cases.map((c) => c.passRate as number)) : null,
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
  /** Result of the equivalence check; its mismatches become the verdict reasons. */
  comparable: boolean;
  comparabilityIssues?: readonly string[];
  deterministicAgent: boolean;
  /** True when any assertion of the suite is nondeterministic (e.g. a future llm-judge). */
  nondeterministicAssertions?: boolean;
}

const fmt = (value: number) => String(Math.round(value * 1000) / 1000);

function errorReasons(
  baseline: Aggregate,
  candidate: Aggregate,
  cases: readonly CaseSummary[],
): string[] {
  const reasons: string[] = [];
  if (baseline.errorRate > 0.5) {
    reasons.push(`baseline error rate ${fmt(baseline.errorRate)} exceeds 0.5`);
  }
  if (candidate.errorRate > 0.5) {
    reasons.push(`candidate error rate ${fmt(candidate.errorRate)} exceeds 0.5`);
  }
  for (const c of cases) {
    if (c.baseline.validRuns === 0) reasons.push(`case ${c.caseId}: no valid baseline runs`);
    if (c.candidate.validRuns === 0) reasons.push(`case ${c.caseId}: no valid candidate runs`);
  }
  return reasons;
}

function instabilityReasons(cases: readonly CaseSummary[], stabilityThreshold: number): string[] {
  const reasons: string[] = [];
  for (const c of cases) {
    for (const [label, a] of [
      ['baseline', c.baseline],
      ['candidate', c.candidate],
    ] as const) {
      if (a.stdDev !== null && a.stdDev > stabilityThreshold + SCORE_EPSILON) {
        reasons.push(
          `case ${c.caseId}: ${label} score stdDev ${fmt(a.stdDev)} exceeds ${stabilityThreshold}`,
        );
      }
      if (a.passRate !== null && a.passRate > SCORE_EPSILON && a.passRate < 1 - SCORE_EPSILON) {
        reasons.push(`case ${c.caseId}: ${label} pass rate ${fmt(a.passRate)} is mixed`);
      }
    }
  }
  return reasons;
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
        ? candidate.meanScore - baseline.meanScore
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
      ? candidate.meanScore - baseline.meanScore
      : null;
  const passRateDelta =
    baseline.passRate !== null && candidate.passRate !== null
      ? candidate.passRate - baseline.passRate
      : null;

  const errors = errorReasons(baseline, candidate, cases);
  const instability = instabilityReasons(cases, scoring.stabilityThreshold);

  let verdict: Verdict;
  let reasons: string[];
  if (errors.length > 0 || delta === null) {
    verdict = 'error';
    reasons = errors.length > 0 ? errors : ['no comparable scores were produced'];
  } else if (!options.comparable) {
    verdict = 'not-comparable';
    reasons = options.comparabilityIssues?.length
      ? [...options.comparabilityIssues]
      : ['equivalence check failed'];
  } else if (instability.length > 0) {
    verdict = 'unstable';
    reasons = instability;
  } else if (delta <= -scoring.minDelta + SCORE_EPSILON) {
    verdict = 'regressed';
    reasons = [`delta ${fmt(delta)} is at or below −${scoring.minDelta} (minDelta)`];
  } else if (delta >= scoring.minDelta - SCORE_EPSILON) {
    verdict = 'improved';
    reasons = [`delta +${fmt(delta)} is at or above ${scoring.minDelta} (minDelta)`];
  } else {
    verdict = 'unchanged';
    reasons = [`|delta| ${fmt(Math.abs(delta))} is below ${scoring.minDelta} (minDelta)`];
  }

  const candidateOutcome =
    verdict === 'error'
      ? null
      : cases.every(
            (c) => c.candidate.passRate !== null && c.candidate.passRate >= 1 - SCORE_EPSILON,
          )
        ? 'passed'
        : 'failed';
  const nondeterministic =
    !options.deterministicAgent || Boolean(options.nondeterministicAssertions);

  return {
    baseline,
    candidate,
    delta,
    passRateDelta,
    verdict,
    reasons,
    candidateOutcome,
    confidence: confidenceFor(options.repetitions, instability.length > 0),
    deterministicAgent: options.deterministicAgent,
    nondeterministic,
    conclusive: !(nondeterministic && options.repetitions < 2),
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
