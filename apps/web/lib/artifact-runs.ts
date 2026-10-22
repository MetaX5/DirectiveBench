import { SCORE_EPSILON, type DisplayStatus } from '@directivebench/benchmark-engine/scoring';
import type { ArtifactRunItem } from '@directivebench/database';
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
}

/** A run that may enter a version comparison: completed, comparable, not an error (FR-111-50). */
interface Eligible {
  version: number;
  verdict: string | null;
  summary: StoredSummary;
  row: VersionRunRow;
}

function eligible(
  item: ArtifactRunItem,
  summary: StoredSummary,
  row: VersionRunRow,
): Eligible | null {
  const { run } = item;
  if (run.status !== 'completed' || run.comparabilityKey === null) return null;
  if (run.verdict === 'error' || run.verdict === 'not-comparable') return null;
  if (!summary.scoring || !summary.candidate) return null;
  return { version: item.artifactVersion.version, verdict: run.verdict, summary, row };
}

/** FR-111-50/51 for the latest eligible runs of two versions with the same comparability key. */
export function compareVersions(
  previous: Pick<Eligible, 'version' | 'verdict' | 'summary'>,
  next: Pick<Eligible, 'verdict' | 'summary'>,
): VersionComparison {
  const previousVersion = previous.version;
  if (previous.verdict === 'unstable' || next.verdict === 'unstable') {
    return { kind: 'inconclusive', previousVersion, reason: 'a compared run is unstable' };
  }
  const before = previous.summary.candidate?.meanScore ?? null;
  const after = next.summary.candidate?.meanScore ?? null;
  const versionDelta = before === null || after === null ? null : after - before;
  // Same key ⇒ same scoring section, so either run's minDelta is the group's.
  const minDelta = next.summary.scoring?.minDelta ?? 0;
  const reasons: string[] = [];
  if (versionDelta !== null && versionDelta <= -minDelta + SCORE_EPSILON) {
    reasons.push(`candidate score fell by at least minDelta (${minDelta})`);
  }
  if (
    previous.summary.candidateOutcome === 'passed' &&
    next.summary.candidateOutcome === 'failed'
  ) {
    reasons.push('candidate outcome changed from passed to failed');
  }
  if (reasons.length > 0) return { kind: 'regression', previousVersion, versionDelta, reasons };
  if (versionDelta === null) {
    return { kind: 'inconclusive', previousVersion, reason: 'a candidate score is missing' };
  }
  return { kind: 'no-regression', previousVersion, versionDelta };
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
 * come from `listArtifactRuns` (newest version first, then newest run first).
 */
export function resultsByVersion(
  versions: readonly { id: string; version: number }[],
  items: readonly ArtifactRunItem[],
): VersionResults[] {
  const blocks = new Map<string, VersionResults>(
    versions.map((v) => [
      v.id,
      { versionId: v.id, version: v.version, groups: [], otherRuns: [], regressed: false },
    ]),
  );
  // Latest eligible run per group and version; the input order puts the latest first.
  const latest = new Map<string, Map<number, Eligible>>();
  for (const item of items) {
    const block = blocks.get(item.artifactVersion.id);
    if (!block) continue;
    const { run } = item;
    if (run.status !== 'completed') {
      block.otherRuns.push({ runId: run.id, status: run.status, startedAt: run.startedAt });
      continue;
    }
    const summary = readSummary(run.summary);
    const row = toRow(item, summary);
    const key = run.comparabilityKey;
    let group = key === null ? undefined : block.groups.find((g) => g.key === key);
    if (!group) {
      group = { key, runs: [] };
      block.groups.push(group);
    }
    group.runs.push(row);
    const candidate = eligible(item, summary, row);
    if (key !== null && candidate) {
      const perVersion = latest.get(key) ?? new Map<number, Eligible>();
      latest.set(key, perVersion);
      if (!perVersion.has(candidate.version)) perVersion.set(candidate.version, candidate);
    }
  }
  for (const perVersion of latest.values()) {
    const ordered = [...perVersion.values()].sort((a, b) => a.version - b.version);
    ordered.forEach((next, index) => {
      const previous = ordered[index - 1];
      if (previous) next.row.comparison = compareVersions(previous, next);
    });
  }
  const results = versions.map((v) => blocks.get(v.id) as VersionResults);
  for (const block of results) {
    block.regressed = block.groups.some((g) =>
      g.runs.some((r) => r.comparison?.kind === 'regression'),
    );
  }
  return results;
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
