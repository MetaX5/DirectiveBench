import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDetection,
  AgentRunRequest,
  AgentRunResult,
  InstalledArtifact,
} from '@directivebench/agent-adapters';
import type { ArtifactBundle } from '@directivebench/core';
import type { BenchmarkDefinitionInput } from '../src/definition';
import { prepareSuiteImport } from '../src/import';
import {
  BenchmarkCancelledError,
  BenchmarkConfigurationError,
  comparabilityKey,
  runBenchmark,
  type AgentRunRecord,
  type RunBenchmarkInput,
} from '../src/orchestrator';
import { nodeScript, useTempDirs } from './helpers';

const tmp = useTempDirs();

type RunHandler = (
  request: AgentRunRequest,
  variant: 'baseline' | 'candidate',
) => Promise<AgentRunResult>;

const completed = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
  status: 'completed',
  durationMs: 1,
  summary: 'done',
  trace: [],
  usage: null,
  error: null,
  ...overrides,
});

/** Writes `out.txt` naming the variant; the candidate is recognised by the installed artifact. */
const writeVariant: RunHandler = async (request, variant) => {
  writeFileSync(join(request.workspaceDir, 'out.txt'), variant);
  return completed({
    trace: [{ type: 'file-written', path: 'out.txt', bytes: variant.length }],
    usage: { inputTokens: 10, outputTokens: 5 },
  });
};

/** A nondeterministic, non-mock adapter whose behaviour each test controls. */
class FakeAdapter implements AgentAdapter {
  readonly id = 'fake';
  readonly displayName = 'Fake agent (test double)';
  capabilities: AgentCapabilities = {
    execution: true,
    headless: true,
    modelSelection: true,
    artifactInstallation: true,
    structuredOutput: true,
    usageReporting: true,
    deterministic: false,
  };
  requests: AgentRunRequest[] = [];
  detectCalls = 0;
  install: (workspaceDir: string) => Promise<InstalledArtifact> = async (workspaceDir) => {
    mkdirSync(join(workspaceDir, '.agent'), { recursive: true });
    writeFileSync(join(workspaceDir, '.agent/skill.md'), 'skill');
    return { paths: ['.agent/skill.md'] };
  };

  constructor(
    private readonly onRun: RunHandler = writeVariant,
    private readonly versions: (string | null)[] = ['1.0'],
  ) {}

  detect(): Promise<AgentDetection> {
    const version = this.versions[Math.min(this.detectCalls, this.versions.length - 1)] ?? null;
    this.detectCalls += 1;
    return Promise.resolve({
      adapterId: this.id,
      installed: true,
      version,
      executablePath: null,
      auth: 'not-required',
      notes: [],
    });
  }

  installArtifact(workspaceDir: string): Promise<InstalledArtifact> {
    return this.install(workspaceDir);
  }

  run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    const variant = existsSync(join(request.workspaceDir, '.agent')) ? 'candidate' : 'baseline';
    return this.onRun(request, variant);
  }
}

const artifact: ArtifactBundle = {
  artifactId: 'art_test',
  versionId: 'artv_test',
  slug: 'skill',
  name: 'Skill',
  type: 'skill',
  format: 'skill-md',
  contentHash: 'hash',
  files: [],
};

type CaseInput = BenchmarkDefinitionInput['cases'][number];

function testCase(overrides: Partial<CaseInput> = {}): CaseInput {
  return {
    id: 'c',
    name: 'Case',
    prompt: 'Write out.txt',
    fixture: { path: 'fixture' },
    verification: { overlay: 'verification' },
    assertions: [
      { id: 'hidden-present', type: 'file-exists', path: 'hidden.txt' },
      { id: 'is-candidate', type: 'file-contains', path: 'out.txt', pattern: '^candidate$' },
      { id: 'scope', type: 'changed-files', allowed: ['out.txt'] },
    ],
    agentOptions: { fake: { mode: 'test' } },
    ...overrides,
  };
}

/** Writes a suite with a fixture and a verification overlay and imports it into a fixture store. */
async function suite(
  overrides: Partial<BenchmarkDefinitionInput> = {},
): Promise<Omit<RunBenchmarkInput, 'adapter' | 'signal'>> {
  const root = tmp('suite');
  mkdirSync(join(root, 'fixture'));
  writeFileSync(join(root, 'fixture/README.md'), 'fixture');
  mkdirSync(join(root, 'verification'));
  writeFileSync(join(root, 'verification/hidden.txt'), 'hidden test');
  const definition: BenchmarkDefinitionInput = {
    schemaVersion: 1,
    id: 'suite',
    name: 'Suite',
    execution: { agent: 'fake', timeoutSeconds: 30, repetitions: 1 },
    cases: [testCase()],
    ...overrides,
  };
  writeFileSync(join(root, 'benchmark.json'), JSON.stringify(definition));
  const store = tmp('store');
  const prepared = await prepareSuiteImport(join(root, 'benchmark.json'), store);
  return {
    definition: prepared.definition,
    fixtures: prepared.fixtures,
    fixtureStore: store,
    artifact,
    workRoot: join(tmp('work'), 'run'),
    executionApproved: true,
  };
}

const signal = () => new AbortController().signal;

describe('runBenchmark with a nondeterministic adapter', () => {
  it('runs baseline and candidate in fresh workspaces and scores them', async () => {
    const input = await suite();
    const adapter = new FakeAdapter();
    const records: AgentRunRecord[] = [];
    const outcome = await runBenchmark({
      ...input,
      adapter,
      signal: signal(),
      onAgentRun: async (record) => {
        records.push(record);
      },
    });

    expect(records.map((r) => r.variant)).toEqual(['baseline', 'candidate']);
    const [baseline, candidate] = outcome.agentRuns;
    expect(baseline).toMatchObject({
      executionStatus: 'completed',
      score: 2 / 3,
      passed: false,
      error: null,
      usage: { inputTokens: 10, outputTokens: 5 },
      changedFiles: [{ path: 'out.txt', change: 'added' }],
    });
    // The overlay is copied after the agent ran, so it is present but not an agent change.
    expect(baseline?.assertions.map((a) => [a.assertionId, a.passed])).toEqual([
      ['hidden-present', true],
      ['is-candidate', false],
      ['scope', true],
    ]);
    expect(candidate).toMatchObject({ executionStatus: 'completed', score: 1, passed: true });
    expect(candidate?.trace).toContainEqual({
      type: 'message',
      text: 'Installed artifact files: .agent/skill.md',
    });
    expect(candidate?.trace).toContainEqual({ type: 'file-written', path: 'out.txt', bytes: 9 });

    // Identical request apart from the workspace.
    expect(adapter.requests.map((r) => [r.prompt, r.timeoutMs, r.model, r.options])).toEqual([
      ['Write out.txt', 30_000, null, { mode: 'test' }],
      ['Write out.txt', 30_000, null, { mode: 'test' }],
    ]);
    expect(adapter.requests[0]?.workspaceDir).not.toBe(adapter.requests[1]?.workspaceDir);

    expect(outcome.summary).toMatchObject({ verdict: 'improved', conclusive: false });
    expect(outcome.environment).toMatchObject({
      adapterId: 'fake',
      adapterVersion: '1.0',
      deterministicAgent: false,
      sandboxed: false,
      repetitions: 1,
      timeoutSeconds: 30,
    });
    expect(outcome.comparabilityKey).toBe(
      comparabilityKey(input.definition, input.fixtures, 'fake', '1.0'),
    );
    expect(outcome.warnings).toEqual([
      'Execution environment "local-process" is not a sandbox: commands run with your user account permissions.',
      'Fewer than 3 repetitions: a single nondeterministic execution is not conclusive.',
      'Single repetition of a nondeterministic run: the result is not conclusive.',
    ]);
    expect(existsSync(input.workRoot)).toBe(false);
  });

  it('keeps workspaces when asked to', async () => {
    const input = await suite();
    await runBenchmark({
      ...input,
      adapter: new FakeAdapter(),
      signal: signal(),
      keepWorkspaces: true,
    });
    const workspace = join(input.workRoot, 'c', 'candidate-1', 'workspace');
    expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('candidate');
    expect(existsSync(join(workspace, 'hidden.txt'))).toBe(true);
    expect(existsSync(join(input.workRoot, 'c', 'baseline-1', 'home'))).toBe(true);
  });

  it('marks results not comparable when the agent version changes during the run', async () => {
    const input = await suite();
    const outcome = await runBenchmark({
      ...input,
      adapter: new FakeAdapter(writeVariant, ['1.0', '1.1']),
      signal: signal(),
    });
    expect(outcome.summary.verdict).toBe('not-comparable');
    expect(outcome.warnings).toContain('agent version changed during the run (1.0 → 1.1)');
    expect(outcome.environment.adapterVersion).toBe('1.0');
  });

  it('records agent errors, preferring the error over the summary', async () => {
    const input = await suite();
    const adapter = new FakeAdapter(async (_request, variant) =>
      variant === 'baseline'
        ? completed({ status: 'agent-error', summary: 'agent crashed', error: null })
        : completed({ status: 'timeout', summary: 'Timed out', error: 'exceeded 30 s' }),
    );
    const outcome = await runBenchmark({ ...input, adapter, signal: signal() });
    expect(outcome.agentRuns.map((r) => [r.executionStatus, r.error, r.score, r.passed])).toEqual([
      ['agent-error', 'agent crashed', null, null],
      ['timeout', 'exceeded 30 s', null, null],
    ]);
    expect(outcome.summary.verdict).toBe('error');
  });

  it('turns thrown adapter errors into infrastructure errors', async () => {
    const input = await suite();
    const adapter = new FakeAdapter();
    let calls = 0;
    adapter.install = () => {
      calls += 1;
      // Adapters are third-party code and may throw anything, not only Error instances.
      return calls === 1
        ? Promise.reject(new Error('cannot write skill'))
        : Promise.reject('plain string');
    };
    const outcome = await runBenchmark({
      ...input,
      definition: {
        ...input.definition,
        execution: { ...input.definition.execution, repetitions: 2 },
      },
      adapter,
      signal: signal(),
    });
    const candidates = outcome.agentRuns.filter((r) => r.variant === 'candidate');
    expect(candidates.map((r) => [r.executionStatus, r.error])).toEqual([
      ['infrastructure-error', 'cannot write skill'],
      ['infrastructure-error', 'plain string'],
    ]);
  });

  it('gives up on an agent that ignores the abort signal after the grace period', async () => {
    const input = await suite({
      execution: { agent: 'fake', timeoutSeconds: 0.05, repetitions: 1 },
    });
    const adapter = new FakeAdapter((request, variant) =>
      variant === 'baseline'
        ? new Promise<AgentRunResult>(() => {})
        : writeVariant(request, variant),
    );
    const outcome = await runBenchmark({ ...input, adapter, signal: signal() });
    expect(outcome.agentRuns[0]).toMatchObject({
      variant: 'baseline',
      executionStatus: 'timeout',
      error: 'Agent did not stop after timeout',
    });
    // The agent still received an abort signal that fired at the timeout.
    expect(adapter.requests[0]?.signal.aborted).toBe(true);
    expect(outcome.agentRuns[1]?.executionStatus).toBe('completed');
  }, 20_000);
});

describe('setup commands', () => {
  it('runs setup before the agent and fails the run on setup errors', async () => {
    const setupCase = (id: string, setup: string[][]) => testCase({ id, setup });
    const input = await suite({
      cases: [
        setupCase('ok', [nodeScript("require('fs').writeFileSync('setup.txt', '1')")]),
        setupCase('exit-code', [nodeScript('process.exit(3)')]),
        setupCase('missing', [['definitely-not-a-command-xyz']]),
        ...(process.platform === 'win32'
          ? []
          : [setupCase('signal', [nodeScript("process.kill(process.pid, 'SIGKILL')")])]),
      ],
    });
    const outcome = await runBenchmark({ ...input, adapter: new FakeAdapter(), signal: signal() });
    const byCase = (id: string) =>
      outcome.agentRuns.find((r) => r.caseId === id && r.variant === 'baseline');

    const ok = byCase('ok');
    expect(ok).toMatchObject({ executionStatus: 'completed', score: 2 / 3 });
    // Setup output is part of the starting state, not an agent change.
    expect(ok?.changedFiles).toEqual([{ path: 'out.txt', change: 'added' }]);
    expect(ok?.trace.flatMap((e) => (e.type === 'stage' ? [e.stage] : []))).toEqual([
      'prepare',
      'setup',
      'agent',
      'verification',
      'assertions',
    ]);
    expect(ok?.trace).toContainEqual(expect.objectContaining({ type: 'setup', exitCode: 0 }));

    expect(byCase('exit-code')).toMatchObject({
      executionStatus: 'infrastructure-error',
      error: expect.stringMatching(/^Setup command failed: .* \(3\)$/) as string,
    });
    expect(byCase('missing')?.error).toMatch(
      /^Setup command failed: definitely-not-a-command-xyz \(.*ENOENT.*\)$/,
    );
    if (process.platform !== 'win32') {
      expect(byCase('signal')?.error).toMatch(/\(SIGKILL\)$/);
    }
    expect(outcome.summary.verdict).toBe('error');
  });

  it('stops the benchmark when cancelled during setup', async () => {
    const input = await suite({
      cases: [testCase({ setup: [nodeScript('setTimeout(() => {}, 30000)')] })],
    });
    const controller = new AbortController();
    const records: AgentRunRecord[] = [];
    const adapter = new FakeAdapter();
    setTimeout(() => controller.abort(), 200);
    await expect(
      runBenchmark({
        ...input,
        adapter,
        signal: controller.signal,
        onAgentRun: async (record) => {
          records.push(record);
        },
      }),
    ).rejects.toThrow(BenchmarkCancelledError);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      executionStatus: 'cancelled',
      error: 'Cancelled during setup',
    });
    expect(adapter.requests).toHaveLength(0);
    expect(existsSync(input.workRoot)).toBe(false);
  }, 20_000);
});

describe('cancellation after the agent started', () => {
  it('discards the result when the run was cancelled while the agent worked', async () => {
    const input = await suite();
    const controller = new AbortController();
    const adapter = new FakeAdapter(async (request, variant) => {
      controller.abort();
      return writeVariant(request, variant);
    });
    const records: AgentRunRecord[] = [];
    await expect(
      runBenchmark({
        ...input,
        adapter,
        signal: controller.signal,
        onAgentRun: async (record) => {
          records.push(record);
        },
      }),
    ).rejects.toThrow(BenchmarkCancelledError);
    expect(records.map((r) => [r.executionStatus, r.error, r.assertions])).toEqual([
      ['cancelled', 'Cancelled', []],
    ]);
  });

  it('stops evaluating assertions once cancelled', async () => {
    const input = await suite({
      cases: [
        testCase({
          verification: undefined,
          assertions: [
            { id: 'slow', type: 'command', command: nodeScript('setTimeout(() => {}, 30000)') },
            { id: 'never', type: 'file-exists', path: 'out.txt' },
          ],
        }),
      ],
    });
    const controller = new AbortController();
    const adapter = new FakeAdapter(async (request, variant) => {
      // Cancel shortly after the agent finished, while assertions are running.
      setTimeout(() => controller.abort(), 300);
      return writeVariant(request, variant);
    });
    const records: AgentRunRecord[] = [];
    await expect(
      runBenchmark({
        ...input,
        adapter,
        signal: controller.signal,
        onAgentRun: async (record) => {
          records.push(record);
        },
      }),
    ).rejects.toThrow(BenchmarkCancelledError);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      executionStatus: 'cancelled',
      error: 'Cancelled during assertions',
    });
  }, 20_000);
});

describe('assertRunnable', () => {
  async function expectRejected(
    change: (input: RunBenchmarkInput, adapter: FakeAdapter) => RunBenchmarkInput,
    message: string,
  ) {
    const base = await suite();
    const adapter = new FakeAdapter();
    const input = change({ ...base, adapter, signal: signal() }, adapter);
    await expect(runBenchmark(input)).rejects.toThrow(new BenchmarkConfigurationError(message));
    // Nothing ran and no workspace was created.
    expect(adapter.detectCalls).toBe(0);
    expect(existsSync(base.workRoot)).toBe(false);
  }

  it('rejects an adapter other than the one the suite requires', async () => {
    await expectRejected(
      (input) => ({
        ...input,
        definition: {
          ...input.definition,
          execution: { ...input.definition.execution, agent: 'codex' },
        },
      }),
      'Suite requires agent "codex" but adapter "fake" was provided.',
    );
  });

  it('rejects detection-only adapters', async () => {
    await expectRejected((input, adapter) => {
      adapter.capabilities = { ...adapter.capabilities, execution: false };
      return input;
    }, 'Agent "fake" cannot execute benchmarks in this build.');
  });

  it('rejects adapters without headless execution', async () => {
    await expectRejected((input, adapter) => {
      adapter.capabilities = { ...adapter.capabilities, headless: false };
      return input;
    }, 'Agent "fake" must support headless execution and artifact installation for RED/GREEN runs.');
  });

  it('rejects artifacts of a type the suite does not evaluate', async () => {
    await expectRejected(
      (input) => ({
        ...input,
        artifact: { ...artifact, type: 'rule' },
        definition: { ...input.definition, artifactTypes: ['skill'] },
      }),
      'Suite evaluates skill artifacts, not rule.',
    );
  });

  it('rejects cases without a recorded fixture snapshot', async () => {
    await expectRejected(
      (input) => ({ ...input, fixtures: {} }),
      'No fixture snapshot recorded for case "c".',
    );
  });
});
