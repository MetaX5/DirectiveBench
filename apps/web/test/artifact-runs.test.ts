import type { ArtifactRunItem } from '@directivebench/database';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  groupCount,
  groupLabel,
  resultsByVersion,
  type VersionResults,
} from '../lib/artifact-runs';
import type { AgentProfile, StoredSummary } from '../lib/run-detail';

const profile: AgentProfile = {
  authMode: 'subscription',
  isolationProfile: 'user-profile',
  permissionProfile: 'edit-only',
  flagsHash: 'f'.repeat(64),
  executionModel: 'claude-sonnet-4-6',
  hostId: 'host-1',
};

const versions = [
  { id: 'v3', version: 3 },
  { id: 'v2', version: 2 },
  { id: 'v1', version: 1 },
];

let sequence = 0;

/** A stored run as `listArtifactRuns` returns it; newest-first order is the caller's job. */
function item(
  version: number,
  overrides: {
    status?: ArtifactRunItem['run']['status'];
    verdict?: string | null;
    key?: string | null;
    score?: number | null;
    outcome?: 'passed' | 'failed' | null;
    baseline?: number | null;
    agent?: string;
    profile?: AgentProfile;
    warnings?: string[];
    summary?: unknown;
  } = {},
): ArtifactRunItem {
  sequence += 1;
  const agent = overrides.agent ?? 'claude-code';
  const summary =
    'summary' in overrides
      ? overrides.summary
      : {
          delta: 0.5,
          candidateOutcome: overrides.outcome ?? 'passed',
          candidate: { meanScore: 'score' in overrides ? overrides.score : 0.8 },
          confidence: { level: 'low' },
          scoring: { minDelta: 0.05 },
          environment: overrides.profile ? { agentProfile: overrides.profile } : {},
        };
  const baseline = overrides.baseline ?? null;
  return {
    run: {
      id: `run_${sequence}`,
      jobId: null,
      suiteVersionId: 'sv',
      artifactVersionId: `v${version}`,
      baselineArtifactVersionId: baseline === null ? null : `v${baseline}`,
      agentAdapterId: agent,
      agentVersion: agent === 'mock' ? null : '2.1.302',
      model: null,
      environment: {},
      status: overrides.status ?? 'completed',
      verdict: 'verdict' in overrides ? (overrides.verdict ?? null) : 'improved',
      summary: summary as Record<string, unknown> | null,
      comparabilityKey: 'key' in overrides ? (overrides.key ?? null) : 'key-a'.padEnd(64, '0'),
      warnings: overrides.warnings ?? [],
      error: null,
      startedAt: `2026-10-${String(10 + version).padStart(2, '0')}T00:00:00.000Z`,
      finishedAt: null,
    },
    suite: { id: 'suite', name: 'Docs suite', version: 1 },
    artifactVersion: { id: `v${version}`, version },
    baselineVersion: baseline === null ? null : { id: `v${baseline}`, version: baseline },
  };
}

function rowOf(results: VersionResults[], runId: string) {
  for (const block of results) {
    for (const group of block.groups) {
      const row = group.runs.find((r) => r.runId === runId);
      if (row) return row;
    }
  }
  throw new Error(`no row ${runId}`);
}

describe('resultsByVersion (SPEC-118 FR-118-50/51)', () => {
  it('lists every version newest first, with an empty block for an untested version', () => {
    const results = resultsByVersion(versions, [item(1)]);
    expect(results.map((b) => [b.version, b.groups.length])).toEqual([
      [3, 0],
      [2, 0],
      [1, 1],
    ]);
  });

  it('shows baseline, agent, auth mode, isolation, model, status, delta and confidence per run', () => {
    const ab = item(2, { baseline: 1, profile, warnings: [] });
    const results = resultsByVersion(versions, [ab]);
    expect(rowOf(results, ab.run.id)).toEqual({
      runId: ab.run.id,
      suite: { id: 'suite', name: 'Docs suite', version: 1 },
      baseline: 'v1',
      agentAdapterId: 'claude-code',
      agentVersion: '2.1.302',
      mock: false,
      authMode: 'subscription',
      isolationProfile: 'user-profile',
      model: 'agent default → claude-sonnet-4-6',
      displayStatus: 'passed',
      delta: 0.5,
      confidence: 'low',
      startedAt: ab.run.startedAt,
      ambientConfig: true,
      comparison: null,
    });
  });

  it('labels mock runs and real runs without a profile honestly', () => {
    const mock = item(1, { agent: 'mock', key: 'mock-key', summary: null });
    const real = item(1, { key: 'real-key' });
    const results = resultsByVersion(versions, [mock, real]);
    expect(rowOf(results, mock.run.id)).toMatchObject({
      mock: true,
      authMode: 'n/a (mock)',
      isolationProfile: 'n/a (mock)',
      model: 'n/a',
      delta: null,
      confidence: null,
      baseline: 'no artifact',
      ambientConfig: false,
    });
    expect(rowOf(results, real.run.id)).toMatchObject({
      mock: false,
      authMode: 'not reported',
      isolationProfile: 'not reported',
    });
  });

  it('groups runs by comparability key; a run without a key is a group of its own', () => {
    const results = resultsByVersion(versions, [
      item(2, { key: 'a' }),
      item(2, { key: 'b' }),
      item(2, { key: 'a' }),
      item(2, { key: null }),
      item(2, { key: null }),
      item(1, { key: 'a' }),
    ]);
    const [, v2, v1] = results;
    expect(v2?.groups.map((g) => [g.key, g.runs.length])).toEqual([
      ['a', 2],
      ['b', 1],
      [null, 1],
      [null, 1],
    ]);
    expect(v1?.groups.map((g) => g.key)).toEqual(['a']);
    expect(groupCount(results)).toBe(4);
    expect(
      groupCount(resultsByVersion(versions, [item(1, { key: 'a' }), item(2, { key: 'a' })])),
    ).toBe(1);
  });

  it('lists runs that did not complete separately, never in a group', () => {
    const running = item(3, { status: 'running', verdict: null });
    const failed = item(3, { status: 'error', verdict: null });
    const [v3] = resultsByVersion(versions, [running, failed]);
    expect(v3?.groups).toEqual([]);
    expect(v3?.otherRuns).toEqual([
      { runId: running.run.id, status: 'running', startedAt: running.run.startedAt },
      { runId: failed.run.id, status: 'error', startedAt: failed.run.startedAt },
    ]);
  });

  it('ignores a run of a version that is not listed', () => {
    expect(resultsByVersion(versions.slice(1), [item(3)]).flatMap((b) => b.groups)).toEqual([]);
  });
});

describe('version regressions within a comparability group (SPEC-111 FR-111-50…52)', () => {
  it('flags a score drop of at least minDelta against the previous tested version', () => {
    const v1 = item(1, { score: 0.9 });
    const v2 = item(2, { score: 0.6, baseline: 1 });
    const results = resultsByVersion(versions, [v2, v1]);
    expect(rowOf(results, v2.run.id).comparison).toEqual({
      kind: 'regression',
      previousVersion: 1,
      versionDelta: expect.closeTo(-0.3, 9),
      reasons: ['candidate score fell by at least minDelta (0.05)'],
    });
    expect(rowOf(results, v1.run.id).comparison).toBeNull();
    expect(results.map((b) => [b.version, b.regressed])).toEqual([
      [3, false],
      [2, true],
      [1, false],
    ]);
  });

  it('compares the latest eligible run of each version and skips untested versions', () => {
    const v1 = item(1, { score: 0.5 });
    const v3Latest = item(3, { score: 0.7 });
    const v3Older = item(3, { score: 0.1 });
    const v3Error = item(3, { verdict: 'error', score: 0 });
    const results = resultsByVersion(versions, [v3Error, v3Latest, v3Older, v1]);
    expect(rowOf(results, v3Latest.run.id).comparison).toEqual({
      kind: 'no-regression',
      previousVersion: 1,
      versionDelta: expect.closeTo(0.2, 9),
    });
    expect(rowOf(results, v3Older.run.id).comparison).toBeNull();
    expect(rowOf(results, v3Error.run.id).comparison).toBeNull();
  });

  it('never compares across comparability groups', () => {
    const v1 = item(1, { key: 'a', score: 1 });
    const v2 = item(2, { key: 'b', score: 0 });
    const results = resultsByVersion(versions, [v2, v1]);
    expect(rowOf(results, v2.run.id).comparison).toBeNull();
    expect(results.some((b) => b.regressed)).toBe(false);
  });

  it('leaves out error, not-comparable, unkeyed and unreadable runs', () => {
    const v1 = item(1, { score: 1 });
    const results = resultsByVersion(versions, [
      item(2, { verdict: 'not-comparable', score: 0 }),
      item(2, { summary: { candidate: { meanScore: 0 } } }),
      item(3, { key: null, score: 0 }),
      v1,
    ]);
    expect(results.some((b) => b.regressed)).toBe(false);
    expect(
      results.flatMap((b) => b.groups.flatMap((g) => g.runs.map((r) => r.comparison))),
    ).toEqual([null, null, null, null]);
  });
});

describe('compareVersions (SPEC-111 FR-111-51)', () => {
  const summary = (
    score: number | null,
    outcome: 'passed' | 'failed' = 'passed',
  ): StoredSummary => ({
    candidate: { meanScore: score },
    candidateOutcome: outcome,
    scoring: { minDelta: 0.1 },
  });

  it('flags an outcome that changed from passed to failed, even without a score drop', () => {
    expect(
      compareVersions(
        { version: 1, verdict: 'improved', summary: summary(0.8) },
        { verdict: 'unchanged', summary: summary(0.8, 'failed') },
      ),
    ).toEqual({
      kind: 'regression',
      previousVersion: 1,
      versionDelta: 0,
      reasons: ['candidate outcome changed from passed to failed'],
    });
  });

  it('treats a drop of exactly minDelta as a regression and a smaller one as none', () => {
    expect(
      compareVersions(
        { version: 1, verdict: 'improved', summary: summary(0.8) },
        { verdict: 'improved', summary: summary(0.7) },
      ).kind,
    ).toBe('regression');
    expect(
      compareVersions(
        { version: 1, verdict: 'improved', summary: summary(0.8) },
        { verdict: 'improved', summary: summary(0.75) },
      ).kind,
    ).toBe('no-regression');
  });

  it('is inconclusive when either run is unstable', () => {
    const unstable = {
      kind: 'inconclusive',
      previousVersion: 1,
      reason: 'a compared run is unstable',
    };
    expect(
      compareVersions(
        { version: 1, verdict: 'unstable', summary: summary(1) },
        { verdict: 'improved', summary: summary(0) },
      ),
    ).toEqual(unstable);
    expect(
      compareVersions(
        { version: 1, verdict: 'improved', summary: summary(1) },
        { verdict: 'unstable', summary: summary(0) },
      ),
    ).toEqual(unstable);
  });

  it('is inconclusive without a score unless the outcome regressed', () => {
    expect(
      compareVersions(
        { version: 2, verdict: 'improved', summary: summary(null) },
        { verdict: 'improved', summary: summary(0.5) },
      ),
    ).toEqual({ kind: 'inconclusive', previousVersion: 2, reason: 'a candidate score is missing' });
    expect(
      compareVersions(
        { version: 2, verdict: 'improved', summary: summary(0.5) },
        { verdict: 'improved', summary: { candidate: { meanScore: null } } },
      ).kind,
    ).toBe('inconclusive');
    expect(
      compareVersions(
        { version: 2, verdict: 'improved', summary: summary(null) },
        { verdict: 'improved', summary: summary(null, 'failed') },
      ),
    ).toMatchObject({ kind: 'regression', versionDelta: null });
  });
});

describe('groupLabel', () => {
  it('shows a short stable key, or that none was recorded', () => {
    expect(groupLabel('0123456789abcdef')).toBe('Comparability group 0123456789ab');
    expect(groupLabel(null)).toBe('No comparability key recorded');
  });
});
