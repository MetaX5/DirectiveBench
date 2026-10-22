import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MockAgentAdapter,
  type AgentRunMetadata,
  type AgentRunRequest,
  type AgentRunResult,
  type SkillActivation,
} from '@directivebench/agent-adapters';
import { loadLocalArtifact, sha256, type ArtifactBundle } from '@directivebench/core';
import {
  BenchmarkStoppedError,
  STOP_CODES,
  agentConditionIssues,
  agentConditionWarnings,
  applySkillActivationRules,
  assertNotStopped,
  observedAgentProfile,
  prepareSuiteImport,
  runBenchmark,
  skillInvocationRates,
  type AgentRunFacts,
  type AgentRunRecord,
  type RunBenchmarkInput,
} from '../src/index';
import { useTempDirs } from './helpers';

const examples = fileURLToPath(new URL('../../../examples', import.meta.url));
const exampleSuite = join(examples, 'benchmarks/mock-input-validation/benchmark.yaml');
const tmp = useTempDirs();

const MODEL = 'claude-sonnet-4-5-20250929';

function metadata(overrides: Partial<AgentRunMetadata> = {}): AgentRunMetadata {
  return {
    adapterVersion: '2.1.302',
    authMode: 'api-key',
    isolationProfile: 'isolated',
    permissionProfile: 'edit-only',
    requestedModel: MODEL,
    executionModel: MODEL,
    reportedModels: [MODEL],
    auxiliaryModels: [],
    mismatchedMessageModels: [],
    flagsHash: 'a'.repeat(64),
    ...overrides,
  };
}

const activation = (overrides: Partial<SkillActivation> = {}): SkillActivation => ({
  loaded: true,
  invoked: true,
  invocations: 1,
  otherSkills: [],
  ...overrides,
});

function facts(overrides: Partial<AgentRunFacts> = {}): AgentRunFacts {
  return {
    caseId: 'c1',
    variant: 'candidate',
    repetition: 1,
    executionStatus: 'completed',
    score: 1,
    passed: true,
    error: null,
    errorCode: null,
    warnings: [],
    metadata: metadata(),
    ...overrides,
  };
}

type Script = (variant: 'baseline' | 'candidate', repetition: number) => Partial<AgentRunResult>;

/**
 * The mock agent with what a real-agent adapter would report added per call — the engine rules
 * are adapter-independent, so the mock's deterministic workspace changes keep the scores known
 * (without the rules: baseline 0.5, candidate 1, verdict `improved`).
 */
class ReportingAdapter extends MockAgentAdapter {
  readonly calls: string[] = [];

  constructor(private readonly script: Script) {
    super();
  }

  override async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const result = await super.run(request);
    const match = /(baseline|candidate)-(\d+)[\\/]workspace$/.exec(request.workspaceDir);
    const variant = match?.[1] as 'baseline' | 'candidate';
    this.calls.push(`${variant}-${match?.[2]}`);
    return { ...result, ...this.script(variant, Number(match?.[2])) };
  }
}

async function skill(): Promise<ArtifactBundle> {
  const loaded = await loadLocalArtifact(
    join(examples, 'artifacts'),
    'validate-external-input/SKILL.md',
  );
  return {
    artifactId: 'art_skill',
    versionId: 'artv_v2',
    slug: loaded.slug,
    name: loaded.parsed.name,
    type: loaded.parsed.type,
    format: loaded.parsed.format,
    contentHash: loaded.contentHash,
    files: loaded.files,
  };
}

async function input(script: Script, extra: Partial<RunBenchmarkInput> = {}) {
  const store = tmp('store');
  const prepared = await prepareSuiteImport(exampleSuite, store);
  const adapter = new ReportingAdapter(script);
  const persisted: AgentRunRecord[] = [];
  const run: RunBenchmarkInput = {
    definition: prepared.definition,
    fixtures: prepared.fixtures,
    fixtureStore: store,
    artifact: await skill(),
    adapter,
    workRoot: join(tmp('work'), 'run'),
    executionApproved: true,
    signal: new AbortController().signal,
    onAgentRun: async (record) => {
      persisted.push(record);
    },
    ...extra,
  };
  return { run, adapter, persisted };
}

async function baselineVersion(): Promise<ArtifactBundle> {
  const content = '---\nname: validate-external-input\ndescription: Earlier.\n---\n\nWrite code.\n';
  return {
    ...(await skill()),
    versionId: 'artv_v1',
    contentHash: sha256(content),
    files: [
      { path: 'SKILL.md', sha256: sha256(content), size: Buffer.byteLength(content), content },
    ],
  };
}

describe('stop on systematic failures (FR-118-15, AC-17)', () => {
  it.each(STOP_CODES)(
    '%s on the first agent run starts no further agent run',
    async (code) => {
      const { run, adapter, persisted } = await input(() => ({
        status: code.startsWith('workspace-') ? 'infrastructure-error' : 'agent-error',
        errorCode: code,
        error: `failed with ${code}`,
        metadata: metadata(),
      }));
      const outcome = runBenchmark(run);
      await expect(outcome).rejects.toThrow(BenchmarkStoppedError);
      await expect(outcome).rejects.toMatchObject({ code });
      expect(adapter.calls).toEqual(['baseline-1']);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.errorCode).toBe(code);
    },
    60_000,
  );

  it('continues after other agent-run failures', async () => {
    const { run, adapter } = await input((variant, repetition) =>
      variant === 'baseline' && repetition === 1
        ? { status: 'agent-error', errorCode: 'agent-failed', error: 'max turns' }
        : {},
    );
    const outcome = await runBenchmark(run);
    expect(adapter.calls).toHaveLength(6);
    expect(outcome.agentRuns[0]).toMatchObject({
      executionStatus: 'agent-error',
      errorCode: 'agent-failed',
    });
  }, 60_000);

  it('names the run and the code, and passes runs without a code', () => {
    expect(() => assertNotStopped(facts({ errorCode: 'auth-expired', error: null }))).toThrow(
      'Stopped after case c1, candidate repetition 1 (auth-expired): no detail. No further agent runs were started.',
    );
    expect(() => assertNotStopped(facts())).not.toThrow();
    expect(() => assertNotStopped(facts({ errorCode: 'agent-failed' }))).not.toThrow();
  });
});

describe('skill activation rules (FR-118-09, AC-21)', () => {
  it('a candidate run without the skill loaded is artifact-not-loaded and stops the run', async () => {
    const { run, persisted } = await input(() => ({
      metadata: metadata(),
      skillActivation: activation({ loaded: false, invoked: false, invocations: 0 }),
    }));
    await expect(runBenchmark(run)).rejects.toMatchObject({ code: 'artifact-not-loaded' });
    // The `none` baseline has nothing installed, so its unloaded skill is expected.
    expect(persisted.map((r) => [r.variant, r.executionStatus, r.errorCode])).toEqual([
      ['baseline', 'completed', null],
      ['candidate', 'infrastructure-error', 'artifact-not-loaded'],
    ]);
    expect(persisted[1]).toMatchObject({ score: null, passed: null });
  }, 60_000);

  it('an A/B baseline run without its version loaded stops the run', async () => {
    const { run } = await input(
      (variant) => ({
        metadata: metadata(),
        skillActivation: activation(variant === 'baseline' ? { loaded: false } : {}),
      }),
      { baselineArtifact: await baselineVersion() },
    );
    await expect(runBenchmark(run)).rejects.toMatchObject({ code: 'artifact-not-loaded' });
  }, 60_000);

  it('a loaded but uninvoked skill is scored with artifact-not-invoked and the invocation rate', async () => {
    const { run } = await input((variant, repetition) => ({
      metadata: metadata(),
      skillActivation:
        variant === 'candidate' && repetition === 1
          ? activation()
          : activation({ invoked: false, invocations: 0, loaded: variant === 'candidate' }),
    }));
    const outcome = await runBenchmark(run);
    expect(outcome.summary.verdict).toBe('improved');
    expect(outcome.summary.skillInvocation).toEqual({
      baseline: { invoked: 0, runs: 3 },
      candidate: { invoked: 1, runs: 3 },
    });
    const candidate = outcome.agentRuns.filter((r) => r.variant === 'candidate');
    expect(candidate.map((r) => r.warnings)).toEqual([
      [],
      ['artifact-not-invoked'],
      ['artifact-not-invoked'],
    ]);
    expect(candidate.every((r) => r.score === 1)).toBe(true);
    expect(outcome.warnings).toContain('Skill invoked in 1/3 candidate runs.');
    expect(outcome.warnings).toContain('artifact-not-invoked: 2/6 agent runs');
    // The metadata event leads the trace and carries the final warnings.
    expect(candidate[1]?.trace[0]).toEqual({
      type: 'agent-metadata',
      metadata: metadata(),
      skillActivation: activation({ invoked: false, invocations: 0 }),
      errorCode: null,
      warnings: ['artifact-not-invoked'],
    });
  }, 60_000);

  it('says the result measures an unused skill when no candidate run invoked it', async () => {
    const { run } = await input((variant) => ({
      metadata: metadata(),
      skillActivation: activation({
        invoked: false,
        invocations: 0,
        loaded: variant === 'candidate',
      }),
    }));
    const outcome = await runBenchmark(run);
    expect(outcome.warnings).toContain(
      'artifact-not-invoked: the skill was never invoked in a candidate run, so the result measures a skill that was never used.',
    );
  }, 60_000);

  it('a none baseline invoking the tested skill is not comparable', async () => {
    const { run } = await input((variant, repetition) => ({
      metadata: metadata(),
      skillActivation:
        variant === 'baseline' && repetition === 2
          ? activation()
          : variant === 'candidate'
            ? activation()
            : activation({ loaded: false, invoked: false, invocations: 0 }),
    }));
    const outcome = await runBenchmark(run);
    expect(outcome.summary.verdict).toBe('not-comparable');
    expect(outcome.summary.reasons).toEqual([
      'baseline-invoked-tested-skill: 1 baseline run(s) without the artifact invoked the tested skill (an ambient copy), so the baseline is not a no-skill control',
    ]);
  }, 60_000);

  it('an A/B run invoking the skill in both variants stays comparable (AC-28)', async () => {
    const { run } = await input(() => ({ metadata: metadata(), skillActivation: activation() }), {
      baselineArtifact: await baselineVersion(),
    });
    const outcome = await runBenchmark(run);
    expect(outcome.summary.verdict).toBe('improved');
    expect(outcome.warnings).toContain(
      'Skill invoked in 3/3 candidate runs and 3/3 baseline runs.',
    );
  }, 60_000);

  it('leaves a cancelled or timed-out run as it is (review m4)', () => {
    const notLoaded = activation({ loaded: false, invoked: false, invocations: 0 });
    for (const executionStatus of ['cancelled', 'timeout'] as const) {
      const record = facts({
        executionStatus,
        score: null,
        passed: null,
        skillActivation: notLoaded,
      });
      expect(applySkillActivationRules(record, false)).toMatchObject({
        executionStatus,
        errorCode: null,
      });
    }
  });

  it('keeps a stop code, replaces another failure code, and adds the warning once', () => {
    const notLoaded = activation({ loaded: false, invoked: false, invocations: 0 });
    const auth = facts({
      executionStatus: 'agent-error',
      errorCode: 'auth-expired',
      skillActivation: notLoaded,
    });
    expect(applySkillActivationRules(auth, false).errorCode).toBe('auth-expired');
    const failed = facts({
      executionStatus: 'agent-error',
      errorCode: 'agent-failed',
      skillActivation: notLoaded,
    });
    expect(applySkillActivationRules(failed, false)).toMatchObject({
      executionStatus: 'infrastructure-error',
      errorCode: 'artifact-not-loaded',
    });
    const uninvoked = facts({
      warnings: ['artifact-not-invoked'],
      skillActivation: activation({ invoked: false, invocations: 0 }),
    });
    expect(applySkillActivationRules(uninvoked, false).warnings).toEqual(['artifact-not-invoked']);
    expect(applySkillActivationRules(facts(), false).warnings).toEqual([]);
  });
});

describe('execution model and agent conditions (FR-118-04, AC-18, AC-25)', () => {
  it('different session models between variants are not comparable, with a different key', async () => {
    const clean = await runBenchmark((await input(() => ({ metadata: metadata() }))).run);
    expect(clean.summary.verdict).toBe('improved');
    expect(clean.environment.agentProfile).toEqual({
      authMode: 'api-key',
      permissionProfile: 'edit-only',
      flagsHash: 'a'.repeat(64),
      executionModel: MODEL,
      isolationProfile: 'isolated',
    });

    const mixed = await runBenchmark(
      (
        await input((variant) => ({
          metadata: metadata(variant === 'baseline' ? { executionModel: 'claude-opus-4-1' } : {}),
        }))
      ).run,
    );
    expect(mixed.summary.verdict).toBe('not-comparable');
    expect(mixed.summary.reasons).toEqual([
      `execution-model-mismatch: agent runs used different execution models (baseline: claude-opus-4-1; candidate: ${MODEL})`,
    ]);
    expect(mixed.environment.agentProfile?.executionModel).toBe(`claude-opus-4-1 | ${MODEL}`);
    expect(mixed.comparabilityKey).not.toBe(clean.comparabilityKey);
  }, 60_000);

  it('a main-conversation message on another model is a mismatch between repetitions', async () => {
    const outcome = await runBenchmark(
      (
        await input((variant, repetition) => ({
          metadata: metadata(
            variant === 'candidate' && repetition === 3
              ? { mismatchedMessageModels: ['claude-opus-4-1'] }
              : {},
          ),
        }))
      ).run,
    );
    expect(outcome.summary.verdict).toBe('not-comparable');
    expect(outcome.summary.reasons[0]).toBe(
      `execution-model-mismatch: agent runs used different execution models (baseline: ${MODEL}; candidate: claude-opus-4-1, ${MODEL})`,
    );
  }, 60_000);

  it('differing auxiliary models stay comparable with warning auxiliary-models', async () => {
    const outcome = await runBenchmark(
      (
        await input((_, repetition) => ({
          metadata: metadata(repetition === 2 ? { auxiliaryModels: ['claude-haiku-4-5'] } : {}),
        }))
      ).run,
    );
    expect(outcome.summary.verdict).toBe('improved');
    expect(outcome.warnings).toContain(
      'auxiliary-models: agent runs used different auxiliary models for internal work (none / claude-haiku-4-5); the execution model was the same',
    );
    expect(outcome.warnings.some((w) => w.startsWith('unpinned-model'))).toBe(false);
  }, 60_000);

  it('any other differing condition is not comparable', async () => {
    const outcome = await runBenchmark(
      (
        await input((variant) => ({
          metadata: metadata(variant === 'baseline' ? { flagsHash: 'b'.repeat(64) } : {}),
        }))
      ).run,
    );
    expect(outcome.summary.verdict).toBe('not-comparable');
    expect(outcome.summary.reasons).toEqual([
      `agent condition flagsHash differs between agent runs (${'a'.repeat(64)}, ${'b'.repeat(64)})`,
    ]);
  }, 60_000);

  it('warns about an unpinned or aliased model and counts adapter warnings', async () => {
    const outcome = await runBenchmark(
      (
        await input(() => ({
          metadata: metadata({ requestedModel: null, authMode: 'subscription' }),
          warnings: ['ambient-user-config'],
        }))
      ).run,
    );
    expect(outcome.warnings).toContain(
      `unpinned-model: the suite does not pin a full model name, so the CLI chose it (${MODEL})`,
    );
    expect(outcome.warnings).toContain('ambient-user-config: 6/6 agent runs');
  }, 60_000);

  it('a user-profile run needs the installation id for its key', async () => {
    const userProfile = () => ({
      metadata: metadata({ authMode: 'subscription', isolationProfile: 'user-profile' }),
    });
    const missing = await runBenchmark((await input(userProfile)).run);
    expect(missing.summary.verdict).toBe('not-comparable');
    expect(missing.summary.reasons[0]).toMatch(/^host-id-missing: /);
    expect(missing.environment.agentProfile).toBeUndefined();

    const withHost = await runBenchmark((await input(userProfile, { hostId: 'host-1' })).run);
    expect(withHost.summary.verdict).toBe('improved');
    expect(withHost.environment.agentProfile).toMatchObject({
      isolationProfile: 'user-profile',
      hostId: 'host-1',
    });
  }, 60_000);
});

describe('pure helpers', () => {
  it('report nothing for runs without metadata (the mock agent)', () => {
    const mock = [
      facts({ metadata: undefined }),
      facts({ metadata: undefined, variant: 'baseline' }),
    ];
    expect(agentConditionIssues(mock, false)).toEqual([]);
    expect(agentConditionWarnings(mock, false)).toEqual([]);
    expect(skillInvocationRates(mock)).toBeUndefined();
    expect(observedAgentProfile(mock, undefined)).toEqual({});
  });

  it('list a variant without reported models as none reported', () => {
    const runs = [
      facts({ variant: 'baseline', metadata: metadata({ executionModel: null }) }),
      facts({ metadata: metadata({ executionModel: 'x' }) }),
      facts({ metadata: metadata({ executionModel: 'y' }) }),
    ];
    expect(agentConditionIssues(runs, true)).toEqual([
      'execution-model-mismatch: agent runs used different execution models (baseline: none reported; candidate: x, y)',
    ]);
    const onlyBaseline = [
      facts({ variant: 'baseline', metadata: metadata({ executionModel: 'x' }) }),
      facts({ variant: 'baseline', metadata: metadata({ executionModel: 'y' }) }),
    ];
    expect(agentConditionIssues(onlyBaseline, true)[0]).toContain('candidate: none reported');
    // No session model at all, and no agent run: still a profile, and no rate.
    expect(
      observedAgentProfile([runs[0] as AgentRunFacts], undefined).profile?.executionModel,
    ).toBe('');
    expect(skillInvocationRates([])).toBeUndefined();
    expect(
      agentConditionWarnings([facts({ metadata: metadata({ executionModel: null }) })], false),
    ).toEqual([]);
  });

  it('count each agent-run warning once per run, sorted by code', () => {
    expect(
      agentConditionWarnings(
        [
          facts({ metadata: undefined, warnings: ['trace-truncated'] }),
          facts({ metadata: undefined, warnings: ['permission-denied', 'permission-denied'] }),
        ],
        false,
      ),
    ).toEqual(['permission-denied: 1/2 agent runs', 'trace-truncated: 1/2 agent runs']);
  });

  it('count the invocation rate over the runs that reported activation', () => {
    expect(
      skillInvocationRates([
        facts({ skillActivation: activation() }),
        facts({ skillActivation: activation({ invoked: false }) }),
        facts(),
      ]),
    ).toEqual({ baseline: { invoked: 0, runs: 0 }, candidate: { invoked: 1, runs: 2 } });
    expect(
      agentConditionWarnings(
        [facts({ variant: 'baseline', skillActivation: activation() })],
        false,
      ),
    ).toEqual(['Skill invoked in 0/0 candidate runs.']);
  });
});
