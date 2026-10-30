// Display logic of the compare page, the same file of two agent runs side by side (SPEC-123
// FR-123-30 to FR-123-32, §10, §11). Pure functions over repository rows, so the page stays
// presentational and every rule is unit-tested.

import { parsePathParam } from './agent-run-files';

/** The agent-run fields these rules read (a subset of the repository row). */
export interface CompareAgentRun {
  id: string;
  caseId: string;
  variant: 'baseline' | 'candidate';
  repetition: number;
}

/** The compare page's query: each value one non-empty string, or null when absent (§10). */
export interface CompareQuery {
  caseId: string | null;
  left: string | null;
  right: string | null;
  path: string | null;
}

type SearchParams = Record<string, string | string[] | undefined>;

/** Parses `?case=&left=&right=&path=`; an empty or repeated value counts as absent (D33). */
export function parseCompareQuery(params: SearchParams): CompareQuery {
  return {
    caseId: parsePathParam(params.case),
    left: parsePathParam(params.left),
    right: parsePathParam(params.right),
    path: parsePathParam(params.path),
  };
}

const variantOrder = { baseline: 0, candidate: 1 } as const;

/** Baseline before candidate, then by repetition: the order of the agent-run selects. */
function byVariantThenRepetition(a: CompareAgentRun, b: CompareAgentRun): number {
  return variantOrder[a.variant] - variantOrder[b.variant] || a.repetition - b.repetition;
}

export type CompareRunsSelection<T extends CompareAgentRun> =
  | { kind: 'runs'; caseId: string; caseRuns: T[]; left: T; right: T }
  | { kind: 'none' }
  | { kind: 'not-found' };

/**
 * The two agent runs to compare (FR-123-30). Both must belong to the benchmark run (the caller
 * passes only its agent runs) and to the requested case; an unknown case or agent run, or one
 * of another case, is not found (§10). Defaults: the first case of the run, left = the baseline
 * run with the lowest repetition (repetition 1), right = the candidate run with the lowest
 * repetition; when the case has no run of that variant, its first agent run.
 */
export function selectCompareRuns<T extends CompareAgentRun>(
  agentRuns: readonly T[],
  query: CompareQuery,
): CompareRunsSelection<T> {
  const caseId = query.caseId ?? agentRuns[0]?.caseId;
  if (caseId === undefined)
    return query.left || query.right ? { kind: 'not-found' } : { kind: 'none' };
  const caseRuns = agentRuns.filter((run) => run.caseId === caseId).sort(byVariantThenRepetition);
  const first = caseRuns[0];
  if (first === undefined) return { kind: 'not-found' };
  const pick = (id: string | null, variant: CompareAgentRun['variant']): T | undefined =>
    id === null
      ? (caseRuns.find((run) => run.variant === variant) ?? first)
      : caseRuns.find((run) => run.id === id);
  const left = pick(query.left, 'baseline');
  const right = pick(query.right, 'candidate');
  if (!left || !right) return { kind: 'not-found' };
  return { kind: 'runs', caseId, caseRuns, left, right };
}

/** One path of the union of two agent runs' changed files (FR-123-30). */
export interface ComparedPath<F> {
  path: string;
  left: F | null;
  right: F | null;
  /** The side that has the path when the other lacks it ("Only left" / "Only right", §11). */
  onlyIn: 'left' | 'right' | null;
}

/** The union of both sides' paths, ordered by path (code-point ascending, as each list is). */
export function comparePaths<F extends { path: string }>(
  left: readonly F[],
  right: readonly F[],
): ComparedPath<F>[] {
  const leftByPath = new Map(left.map((file) => [file.path, file]));
  const rightByPath = new Map(right.map((file) => [file.path, file]));
  // The paths are distinct (a set), so the comparator never sees two equal ones.
  const paths = [...new Set([...leftByPath.keys(), ...rightByPath.keys()])].sort((a, b) =>
    a < b ? -1 : 1,
  );
  return paths.map((path) => {
    const l = leftByPath.get(path) ?? null;
    const r = rightByPath.get(path) ?? null;
    return { path, left: l, right: r, onlyIn: r === null ? 'left' : l === null ? 'right' : null };
  });
}

/** The URL of the compare page; `path` is left out when the default (first path) is meant. */
export function compareHref(
  benchmarkRunId: string,
  query: { caseId: string; left: string; right: string; path?: string },
): string {
  const params = new URLSearchParams({ case: query.caseId, left: query.left, right: query.right });
  if (query.path !== undefined) params.set('path', query.path);
  return `/results/${encodeURIComponent(benchmarkRunId)}/compare?${params.toString()}`;
}
