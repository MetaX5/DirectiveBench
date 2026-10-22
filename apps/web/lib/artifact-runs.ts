import { SCORE_EPSILON, type DisplayStatus } from '@directivebench/benchmark-engine/scoring';
import {
  ARTIFACT_VERSION_COMPARISON_LIMIT,
  type ArtifactRunItem,
  type VersionComparisonRun,
} from '@directivebench/database';
import { isMockAgent } from './mock-agent';
import {
  baselineName,
  hasAmbientConfig,
  modelLabel,
  NOT_REPORTED,
  readSummary,
  type StoredSummary,
} from './run-detail';
import { runDisplayStatus } from './run-status';

/**
 * Results by artifact version (SPEC-118 FR-118-50/51, SPEC-113 FR-113-21/22): one block per
 * version, newest first, with the version's completed runs grouped by comparability key, and
 * version regressions within a group per SPEC-111 FR-111-50…52. Numbers are only ever compared
 * inside one group (FR-111-45).
 */

/** How a version compares with the previous tested version in the same group (FR-111-50/51). */
export type VersionComparison =
  | { kind: 'regression'; previousVersion: number; versionDelta: number | null; reasons: string[] }
  | { kind: 'no-regression'; previousVersion: number; versionDelta: number }
  | { kind: 'inconclusive'; previousVersion: number; reason: string };

export interface VersionRunRow {
  runId: string;
  suite: { id: string; name: string; version: number };
  /** "no artifact" or "vN" (FR-118-50). */
  baseline: string;
  agentAdapterId: string;
  agentVersion: string | null;
  mock: boolean;
  authMode: string;
  isolationProfile: string;
  model: string;
  displayStatus: DisplayStatus;
  delta: number | null;
  confidence: string | null;
  startedAt: string;
  /** The results may include the user's own configuration (SPEC-118 §12). */
  ambientConfig: boolean;
  /** Set on the run a version comparison used: the latest eligible run of its version. */
  comparison: VersionComparison | null;
}

export interface ComparabilityGroup {
  /** Null for a completed run without a key; such a run is a group of its own. */
  key: string | null;
  runs: VersionRunRow[];
}

export interface VersionResults {
  versionId: string;
  version: number;
  groups: ComparabilityGroup[];
  /** Runs of this version that did not complete (running, error, cancelled, interrupted). */
  otherRuns: { runId: string; status: string; startedAt: string }[];
  /** At least one group flags a version regression for this version. */
  regressed: boolean;
  /** Every flagged regression of this version comes from mock-agent runs (label them so). */
  regressionMockOnly: boolean;
}

/** The fields of a representative run a version comparison reads (FR-111-50/51). */
export type ComparedRun = Pick<
  VersionComparisonRun,
  'version' | 'verdict' | 'candidateMeanScore' | 'candidateOutcome' | 'minDelta'
>;

/** FR-111-50/51 for the latest eligible runs of two versions with the same comparability key. */
export function compareVersions(previous: ComparedRun, next: ComparedRun): VersionComparison {
  const previousVersion = previous.version;
  if (previous.verdict === 'unstable' || next.verdict === 'unstable') {
    return { kind: 'inconclusive', previousVersion, reason: 'a compared run is unstable' };
  }
  const before = previous.candidateMeanScore;
  const after = next.candidateMeanScore;
  const versionDelta = before === null || after === null ? null : after - before;
  // Same key ⇒ same scoring section, so either run's minDelta is the group's.
  const { minDelta } = next;
  const reasons: string[] = [];
  if (versionDelta !== null && versionDelta <= -minDelta + SCORE_EPSILON) {
    reasons.push(`candidate score fell by at least minDelta (${minDelta})`);
  }
  if (previous.candidateOutcome === 'passed' && next.candidateOutcome === 'failed') {
    reasons.push('candidate outcome changed from passed to failed');
  }
  if (reasons.length > 0) return { kind: 'regression', previousVersion, versionDelta, reasons };
  if (versionDelta === null) {
    return { kind: 'inconclusive', previousVersion, reason: 'a candidate score is missing' };
  }
  return { kind: 'no-regression', previousVersion, versionDelta };
}

/**
 * Version comparisons keyed by the representative run they belong to: within each comparability
 * key, each version's representative is compared with that of the previous tested version.
 * Linear in the number of representatives apart from one sort per key.
 */
export function versionComparisons(
  representatives: readonly VersionComparisonRun[],
): Map<string, { run: VersionComparisonRun; comparison: VersionComparison }> {
  const byKey = new Map<string, VersionComparisonRun[]>();
  for (const run of representatives) {
    const runs = byKey.get(run.comparabilityKey);
    if (runs) runs.push(run);
    else byKey.set(run.comparabilityKey, [run]);
  }
  const result = new Map<string, { run: VersionComparisonRun; comparison: VersionComparison }>();
  for (const runs of byKey.values()) {
    runs.sort((a, b) => a.version - b.version);
    runs.forEach((next, index) => {
      const previous = runs[index - 1];
      if (previous)
        result.set(next.runId, { run: next, comparison: compareVersions(previous, next) });
    });
  }
  return result;
}

function toRow(item: ArtifactRunItem, summary: StoredSummary): VersionRunRow {
  const { run } = item;
  const profile = summary.environment?.agentProfile ?? null;
  const mock = isMockAgent(run.agentAdapterId);
  return {
    runId: run.id,
    suite: item.suite,
    baseline: baselineName(item.baselineVersion),
    agentAdapterId: run.agentAdapterId,
    agentVersion: run.agentVersion,
    mock,
    authMode: profile?.authMode ?? (mock ? 'n/a (mock)' : NOT_REPORTED),
    isolationProfile: profile?.isolationProfile ?? (mock ? 'n/a (mock)' : NOT_REPORTED),
    model: modelLabel(run.model, profile),
    displayStatus: runDisplayStatus(run),
    delta: summary.delta ?? null,
    confidence: summary.confidence?.level ?? null,
    startedAt: run.startedAt,
    ambientConfig: hasAmbientConfig(run.warnings, profile),
    comparison: null,
  };
}

/**
 * Builds the results by version. `versions` are the artifact's versions newest first; `items`
 * come from `listArtifactRuns` (the page window: newest version first, then newest run first);
 * `representatives` from `listVersionComparisonRuns`, so regressions do not depend on the window.
 * Linear in the number of runs: groups are found through a map, never by a search per run.
 */
export function resultsByVersion(
  versions: readonly { id: string; version: number }[],
  items: readonly ArtifactRunItem[],
  representatives: readonly VersionComparisonRun[],
): VersionResults[] {
  const blocks = new Map<string, VersionResults>(
    versions.map((v) => [
      v.id,
      {
        versionId: v.id,
        version: v.version,
        groups: [],
        otherRuns: [],
        regressed: false,
        regressionMockOnly: false,
      },
    ]),
  );
  const keyedGroups = new Map<string, Map<string, ComparabilityGroup>>();
  const comparisons = versionComparisons(representatives);
  for (const item of items) {
    const block = blocks.get(item.artifactVersion.id);
    if (!block) continue;
    const { run } = item;
    if (run.status !== 'completed') {
      block.otherRuns.push({ runId: run.id, status: run.status, startedAt: run.startedAt });
      continue;
    }
    const row = toRow(item, readSummary(run.summary));
    row.comparison = comparisons.get(run.id)?.comparison ?? null;
    const key = run.comparabilityKey;
    const groups = keyedGroups.get(block.versionId) ?? new Map<string, ComparabilityGroup>();
    keyedGroups.set(block.versionId, groups);
    let group = key === null ? undefined : groups.get(key);
    if (!group) {
      group = { key, runs: [] };
      block.groups.push(group);
      if (key !== null) groups.set(key, group);
    }
    group.runs.push(row);
  }
  // Version headers use every representative, also one outside the page window.
  for (const { run, comparison } of comparisons.values()) {
    const block = blocks.get(run.artifactVersionId);
    if (!block || comparison.kind !== 'regression') continue;
    const mock = isMockAgent(run.agentAdapterId);
    block.regressionMockOnly = block.regressed ? block.regressionMockOnly && mock : mock;
    block.regressed = true;
  }
  return versions.map((v) => blocks.get(v.id) as VersionResults);
}

/** Distinct comparability groups over all versions; more than one means "not comparable". */
export function groupCount(results: readonly VersionResults[]): number {
  const keys = new Set<string>();
  let unkeyed = 0;
  for (const block of results) {
    for (const group of block.groups) {
      if (group.key === null) unkeyed += 1;
      else keys.add(group.key);
    }
  }
  return keys.size + unkeyed;
}

/** Short, stable label of a comparability group; the same key reads the same in every version. */
export function groupLabel(key: string | null): string {
  return key === null ? 'No comparability key recorded' : `Comparability group ${key.slice(0, 12)}`;
}

/**
 * Notices for a bounded history (Codex review of PR #112): the page loads the newest runs only,
 * and version regressions use at most `ARTIFACT_VERSION_COMPARISON_LIMIT` version-and-group pairs.
 */
export function historyNotices(
  shown: number,
  total: number,
  comparisonsTruncated: boolean,
): string[] {
  const notices: string[] = [];
  if (total > shown) {
    notices.push(
      `Showing the latest ${shown} of ${total} runs (newest versions first). Older runs are not listed; version regressions still compare the latest run of every version and group.`,
    );
  }
  if (comparisonsTruncated) {
    notices.push(
      `Version regressions cover the newest ${ARTIFACT_VERSION_COMPARISON_LIMIT} version-and-group pairs; older versions show no comparison.`,
    );
  }
  return notices;
}
