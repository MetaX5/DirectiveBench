import type { ArtifactRunItem, VersionComparisonRun } from '@directivebench/database';
import { ARTIFACT_VERSION_COMPARISON_LIMIT } from '@directivebench/database';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  groupCount,
  groupLabel,
  historyNotices,
  resultsByVersion,
  versionComparisons,
  type ComparedRun,
  type VersionResults,
} from '../lib/artifact-runs';
import type { AgentProfile } from '../lib/run-detail';

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

/** A run as `listArtifactRuns` returns it (lean summary); newest-first order is the caller's job. */
function item(
  version: number,
  overrides: {
    status?: ArtifactRunItem['run']['status'];
    verdict?: string | null;
    key?: string | null;
    baseline?: number | null;
    agent?: string;
    profile?: AgentProfile;
    warnings?: string[];
    summary?: Record<string, unknown> | null;
  } = {},
): ArtifactRunItem {
  sequence += 1;
  const agent = overrides.agent ?? 'claude-code';
  const summary =
    'summary' in overrides
      ? (overrides.summary ?? null)
      : {
          delta: 0.5,
          verdict: 'improved',
          candidateOutcome: 'passed',
          candidate: { meanScore: 0.8 },
          confidence: { level: 'low' },
          scoring: { minDelta: 0.05 },
          environment: { agentProfile: overrides.profile ?? null },
        };
  const baseline = overrides.baseline ?? null;
  return {
    run: {
      id: `run_${sequence}`,
      status: overrides.status ?? 'completed',
      verdict: 'verdict' in overrides ? (overrides.verdict ?? null) : 'improved',
      comparabilityKey: 'key' in overrides ? (overrides.key ?? null) : 'key-a',
      agentAdapterId: agent,
      agentVersion: agent === 'mock' ? null : '2.1.302',
      model: null,
      warnings: overrides.warnings ?? [],
      startedAt: `2026-10-${String(10 + version).padStart(2, '0')}T00:00:00.000Z`,
      summary,
    },
    suite: { id: 'suite', name: 'Docs suite', version: 1 },
    artifactVersion: { id: `v${version}`, version },
    baselineVersion: baseline === null ? null : { id: `v${baseline}`, version: baseline },
  };
}

/** A representative run for version comparisons (`listVersionComparisonRuns`). */
function rep(
  run: ArtifactRunItem | { id: string; version: number; key?: string; agent?: string },
  overrides: Partial<VersionComparisonRun> = {},
): VersionComparisonRun {
  const base =
    'run' in run
      ? {
          runId: run.run.id,
          artifactVersionId: run.artifactVersion.id,
          version: run.artifactVersion.version,
          comparabilityKey: run.run.comparabilityKey as string,
          verdict: run.run.verdict,
          agentAdapterId: run.run.agentAdapterId,
        }
      : {
          runId: run.id,
          artifactVersionId: `v${run.version}`,
          version: run.version,
          comparabilityKey: run.key ?? 'key-a',
          verdict: 'improved',
          agentAdapterId: run.agent ?? 'claude-code',
        };
  return {
    ...base,
    candidateMeanScore: 0.8,
    candidateOutcome: 'passed',
    minDelta: 0.05,
    ...overrides,
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
    const results = resultsByVersion(versions, [item(1)], []);
    expect(results.map((b) => [b.version, b.groups.length])).toEqual([
      [3, 0],
      [2, 0],
      [1, 1],
    ]);
  });

  it('shows baseline, agent, auth mode, isolation, model, status, delta and confidence per run', () => {
    const ab = item(2, { baseline: 1, profile });
    const results = resultsByVersion(versions, [ab], []);
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

  it('reads a lean summary without stored values as not reported, never invented', () => {
    const bare = item(1, {
      summary: {
        delta: null,
        verdict: null,
        candidateOutcome: null,
        candidate: { meanScore: null },
        confidence: { level: null },
        scoring: { minDelta: null },
        environment: { agentProfile: null },
      },
    });
    expect(rowOf(resultsByVersion(versions, [bare], []), bare.run.id)).toMatchObject({
      authMode: 'not reported',
      isolationProfile: 'not reported',
      delta: null,
      confidence: null,
      displayStatus: 'failed',
    });
  });

  it('labels mock runs and real runs without a profile honestly', () => {
    const mock = item(1, { agent: 'mock', key: 'mock-key', summary: null });
    const real = item(1, { key: 'real-key' });
    const results = resultsByVersion(versions, [mock, real], []);
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
    const results = resultsByVersion(
      versions,
      [
        item(2, { key: 'a' }),
        item(2, { key: 'b' }),
        item(2, { key: 'a' }),
        item(2, { key: null }),
        item(2, { key: null }),
        item(1, { key: 'a' }),
      ],
      [],
    );
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
      groupCount(resultsByVersion(versions, [item(1, { key: 'a' }), item(2, { key: 'a' })], [])),
    ).toBe(1);
  });

  it('groups many distinct keys in linear time (Codex review of PR #112)', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => item(1, { key: `k${i}`, summary: null }));
    // Time per call: the best of five rounds of `calls` calls, so a garbage collection or a busy
    // runner does not count, and the small input runs long enough for the clock (issue #120:
    // one sub-millisecond sample made the ratio 48 on macOS).
    const ROUNDS = 5;
    const time = (runs: ArtifactRunItem[], calls: number) => {
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < ROUNDS; round += 1) {
        const start = performance.now();
        for (let call = 0; call < calls; call += 1) {
          const [, , v1] = resultsByVersion(versions, runs, []);
          expect(v1?.groups).toHaveLength(runs.length);
        }
        best = Math.min(best, (performance.now() - start) / calls);
      }
      return best;
    };
    const small = many(2_000);
    const large = many(20_000);
    const ratio = time(large, 1) / time(small, 10);
    // Linear: ~10×. The former search per run was quadratic: ~100× (2.1 s for 20 000 keys).
    expect(ratio).toBeLessThan(40);
  });

  it('lists runs that did not complete separately, never in a group', () => {
    const running = item(3, { status: 'running', verdict: null });
    const failed = item(3, { status: 'error', verdict: null });
    const [v3] = resultsByVersion(versions, [running, failed], []);
    expect(v3?.groups).toEqual([]);
    expect(v3?.otherRuns).toEqual([
      { runId: running.run.id, status: 'running', startedAt: running.run.startedAt },
      { runId: failed.run.id, status: 'error', startedAt: failed.run.startedAt },
    ]);
  });

  it('ignores runs and representatives of a version that is not listed', () => {
    const v3 = item(3);
    const results = resultsByVersion(
      versions.slice(1),
      [v3],
      [rep({ id: 'x', version: 2 }, { candidateMeanScore: 1 }), rep(v3, { candidateMeanScore: 0 })],
    );
    expect(results.flatMap((b) => b.groups)).toEqual([]);
    expect(results.some((b) => b.regressed)).toBe(false);
  });
});

describe('version regressions within a comparability group (SPEC-111 FR-111-50…52)', () => {
  it('attaches the comparison of a representative to its row and flags the version', () => {
    const v1 = item(1);
    const v2 = item(2, { baseline: 1 });
    const results = resultsByVersion(
      versions,
      [v2, v1],
      [rep(v2, { candidateMeanScore: 0.6 }), rep(v1, { candidateMeanScore: 0.9 })],
    );
    expect(rowOf(results, v2.run.id).comparison).toEqual({
      kind: 'regression',
      previousVersion: 1,
      versionDelta: expect.closeTo(-0.3, 9),
      reasons: ['candidate score fell by at least minDelta (0.05)'],
    });
    expect(rowOf(results, v1.run.id).comparison).toBeNull();
    expect(results.map((b) => [b.version, b.regressed, b.regressionMockOnly])).toEqual([
      [3, false, false],
      [2, true, false],
      [1, false, false],
    ]);
  });

  it('flags a version from representatives outside the page window', () => {
    const shown = item(2, { key: 'other' });
    const results = resultsByVersion(
      versions,
      [shown],
      [
        rep({ id: 'hidden-2', version: 2 }, { candidateMeanScore: 0.1 }),
        rep({ id: 'hidden-1', version: 1 }, { candidateMeanScore: 0.9 }),
      ],
    );
    expect(results[1]?.regressed).toBe(true);
    expect(rowOf(results, shown.run.id).comparison).toBeNull();
  });

  it('marks a version whose only regressions come from the mock agent', () => {
    const mockReps = [
      rep({ id: 'm2', version: 2, key: 'm', agent: 'mock' }, { candidateMeanScore: 0.2 }),
      rep({ id: 'm1', version: 1, key: 'm', agent: 'mock' }, { candidateMeanScore: 1 }),
    ];
    const [, v2] = resultsByVersion(versions, [], mockReps);
    expect([v2?.regressed, v2?.regressionMockOnly]).toEqual([true, true]);
    const real2 = rep({ id: 'r2', version: 2, key: 'r' }, { candidateMeanScore: 0.2 });
    const real1 = rep({ id: 'r1', version: 1, key: 'r' }, { candidateMeanScore: 1 });
    for (const order of [
      [...mockReps, real2, real1],
      [real2, real1, ...mockReps],
    ]) {
      const mixed = resultsByVersion(versions, [], order);
      expect([mixed[1]?.regressed, mixed[1]?.regressionMockOnly]).toEqual([true, false]);
    }
  });

  it('compares each version with the previous tested one and never across keys', () => {
    const comparisons = versionComparisons([
      rep({ id: 'a3', version: 3 }, { candidateMeanScore: 0.7 }),
      rep({ id: 'b2', version: 2, key: 'b' }, { candidateMeanScore: 0 }),
      rep({ id: 'a1', version: 1 }, { candidateMeanScore: 0.5 }),
      rep({ id: 'c1', version: 1, key: 'c' }, { candidateMeanScore: 1 }),
    ]);
    expect([...comparisons.keys()]).toEqual(['a3']);
    expect(comparisons.get('a3')?.comparison).toEqual({
      kind: 'no-regression',
      previousVersion: 1,
      versionDelta: expect.closeTo(0.2, 9),
    });
  });
});

describe('compareVersions (SPEC-111 FR-111-51)', () => {
  const run = (
    version: number,
    score: number | null,
    outcome: string | null = 'passed',
    verdict: string | null = 'improved',
  ): ComparedRun => ({
    version,
    verdict,
    candidateMeanScore: score,
    candidateOutcome: outcome,
    minDelta: 0.1,
  });

  it('flags an outcome that changed from passed to failed, even without a score drop', () => {
    expect(compareVersions(run(1, 0.8), run(2, 0.8, 'failed', 'unchanged'))).toEqual({
      kind: 'regression',
      previousVersion: 1,
      versionDelta: 0,
      reasons: ['candidate outcome changed from passed to failed'],
    });
  });

  it('treats a drop of exactly minDelta as a regression and a smaller one as none', () => {
    expect(compareVersions(run(1, 0.8), run(2, 0.7)).kind).toBe('regression');
    expect(compareVersions(run(1, 0.8), run(2, 0.75)).kind).toBe('no-regression');
  });

  it('is inconclusive when either run is unstable', () => {
    const unstable = {
      kind: 'inconclusive',
      previousVersion: 1,
      reason: 'a compared run is unstable',
    };
    expect(compareVersions(run(1, 1, 'passed', 'unstable'), run(2, 0))).toEqual(unstable);
    expect(compareVersions(run(1, 1), run(2, 0, 'passed', 'unstable'))).toEqual(unstable);
  });

  it('is inconclusive without a score unless the outcome regressed', () => {
    expect(compareVersions(run(2, null), run(3, 0.5))).toEqual({
      kind: 'inconclusive',
      previousVersion: 2,
      reason: 'a candidate score is missing',
    });
    expect(compareVersions(run(2, 0.5), run(3, null, null)).kind).toBe('inconclusive');
    expect(compareVersions(run(2, null), run(3, null, 'failed'))).toMatchObject({
      kind: 'regression',
      versionDelta: null,
    });
  });
});

describe('historyNotices (Codex review of PR #112)', () => {
  it('names a truncated page window and truncated comparisons', () => {
    expect(historyNotices(5, 5, false)).toEqual([]);
    expect(historyNotices(200, 1234, true)).toEqual([
      'Showing the latest 200 of 1234 runs (newest versions first). Older runs are not listed; version regressions still compare the latest run of every version and group.',
      `Version regressions cover the newest ${ARTIFACT_VERSION_COMPARISON_LIMIT} version-and-group pairs; older versions show no comparison.`,
    ]);
  });
});

describe('groupLabel', () => {
  it('shows a short stable key, or that none was recorded', () => {
    expect(groupLabel('0123456789abcdef')).toBe('Comparability group 0123456789ab');
    expect(groupLabel(null)).toBe('No comparability key recorded');
  });
});
