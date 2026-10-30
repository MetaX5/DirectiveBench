// Display logic of the compare page, the same file of two agent runs side by side (SPEC-123
// FR-123-30 to FR-123-32, §10, §11). Pure functions over repository rows, so the page stays
// presentational and every rule is unit-tested.

import {
  agentRunFilesNotice,
  agentRunLabel,
  agentRunStatusBadge,
  parsePathParam,
  type AgentRunOutputState,
} from './agent-run-files';
import type { FileBadge, FileChange } from './output-files';

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

/**
 * The side an "Only left" / "Only right" badge names (§11): only when the other agent run kept
 * its files, since a run that kept none cannot show what it lacks (compare-page browser QA
 * finding 1); null otherwise and for a path on both sides.
 */
export function onlyInSide(
  entry: { onlyIn: 'left' | 'right' | null },
  kept: { left: boolean; right: boolean },
): 'left' | 'right' | null {
  if (entry.onlyIn === null) return null;
  return kept[entry.onlyIn === 'left' ? 'right' : 'left'] ? entry.onlyIn : null;
}

/** The union of both sides' paths, ordered by path (JavaScript string order). */
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

/**
 * The URL of the compare page. Left out values take their defaults: the runs of FR-123-30 (the
 * run page's entry link, D36) and the first path.
 */
export function compareHref(
  benchmarkRunId: string,
  query: { caseId: string; left?: string; right?: string; path?: string },
): string {
  const params = new URLSearchParams({ case: query.caseId });
  if (query.left !== undefined) params.set('left', query.left);
  if (query.right !== undefined) params.set('right', query.right);
  if (query.path !== undefined) params.set('path', query.path);
  return `/results/${encodeURIComponent(benchmarkRunId)}/compare?${params.toString()}`;
}

/**
 * The badge of a path both agent runs changed (D43): "Identical" when both changed it the same
 * way to the same original bytes (stored sha256, so a truncated side still compares in full),
 * "Differs" otherwise. A property of the pair, not a judgement, so `outline` as the change
 * badges (D2): green would read as a passed run.
 */
export function pairBadge(
  left: { change: FileChange; sha256: string | null },
  right: { change: FileChange; sha256: string | null },
): FileBadge {
  const identical = left.change === right.change && left.sha256 === right.sha256;
  return { label: identical ? 'Identical' : 'Differs', variant: 'outline' };
}

export interface ComparePathSelection {
  /** The path to show, or null when neither agent run lists a file. */
  path: string | null;
  /** A requested path neither agent run lists; the first path is shown instead (D38). */
  missing: string | null;
}

/** The path to show: the requested one when listed, otherwise the first path (FR-123-30, D38). */
export function selectComparePath(
  paths: readonly string[],
  requested: string | null,
): ComparePathSelection {
  if (requested !== null && paths.includes(requested)) return { path: requested, missing: null };
  return { path: paths[0] ?? null, missing: requested };
}

/** "<path> is not in either agent run, so the first file is shown." (D38). */
export function missingPathNotice(path: string): string {
  return `${path} is not in either agent run, so the first file is shown.`;
}

/**
 * Why one side lists no file (D41): the files-page sentence (D34) after the side's name, for
 * example "Left: Output files were not kept for this agent run."; null when it lists files.
 */
export function compareSideNotice(
  name: string,
  run: Pick<AgentRunOutputState, 'outputFilesKept' | 'outputFilesReason'>,
  fileCount: number,
): string | null {
  const notice = agentRunFilesNotice(run, fileCount);
  return notice === null ? null : `${name}: ${notice}`;
}

/** An agent-run option: "Baseline (v2), repetition 1 (passed)" (D39). */
export function compareRunOptionLabel(
  variantLabel: string,
  run: Pick<AgentRunOutputState, 'executionStatus' | 'passed'> & { repetition: number },
): string {
  return `${agentRunLabel(variantLabel, run.repetition)} (${agentRunStatusBadge(run).label})`;
}
