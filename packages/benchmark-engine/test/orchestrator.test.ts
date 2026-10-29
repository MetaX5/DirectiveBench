import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as AgentAdapters from '@directivebench/agent-adapters';
import { ClaudeCodeError } from '@directivebench/agent-adapters';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentDetection,
  AgentRunRequest,
  AgentRunResult,
  InstalledArtifact,
  WorkspacePin,
} from '@directivebench/agent-adapters';
import { findSecretRanges, type ArtifactBundle } from '@directivebench/core';
import type { BenchmarkDefinitionInput } from '../src/definition';
import { prepareSuiteImport } from '../src/import';
import {
  BenchmarkCancelledError,
  BenchmarkConfigurationError,
  comparabilityKey,
  OUTPUT_NOT_CAPTURED_REASON,
  runBenchmark,
  type AgentRunRecord,
  type RunBenchmarkInput,
} from '../src/orchestrator';
import { NOT_CAPTURED, type OutputFilesCapture } from '../src/output-files';
import { BenchmarkStoppedError } from '../src/agent-conditions';
import { collectGarbage, nodeScript, useTempDirs } from './helpers';

/** When set, the process-group kill after a command reports a survivor (`strayProcesses`). */
const strayGroup = vi.hoisted(() => ({ survives: false }));
vi.mock('@directivebench/agent-adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentAdapters>();
  return {
    ...actual,
    killProcessGroup: async (...args: Parameters<typeof actual.killProcessGroup>) =>
      strayGroup.survives ? false : actual.killProcessGroup(...args),
  };
});

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
  writeFileSync(join(request.workspace.path, 'out.txt'), variant);
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

  installArtifact(workspace: WorkspacePin): Promise<InstalledArtifact> {
    return this.install(workspace.path);
  }

  /** The core rules only, unless a test replaces it. */
  findOutputSecrets: AgentAdapter['findOutputSecrets'] = (text, options) =>
    findSecretRanges(text, [], options);

  run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    const variant = existsSync(join(request.workspace.path, '.agent')) ? 'candidate' : 'baseline';
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
    expect(adapter.requests[0]?.workspace.path).not.toBe(adapter.requests[1]?.workspace.path);

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
    // The agent still received an abort signal that fired at the timeout, and it stays aborted
    // after a collection: an adapter that polls `signal.aborted` must not lose the timeout.
    await collectGarbage();
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

  it('pins the workspace before setup and hands the pin, installed paths and a scratch directory to the adapter', async () => {
    const input = await suite({ execution: { agent: 'fake', timeoutSeconds: 30, repetitions: 1 } });
    const adapter = new FakeAdapter();
    const pins: WorkspacePin[] = [];
    const install = adapter.install;
    adapter.installArtifact = (workspace: WorkspacePin) => {
      pins.push(workspace);
      return install(workspace.path);
    };
    const scratch: string[][] = [];
    const onRun = adapter.run.bind(adapter);
    adapter.run = async (request) => {
      scratch.push(readdirSync(request.scratchDir));
      return onRun(request);
    };
    await runBenchmark({ ...input, adapter, keepWorkspaces: true, signal: signal() });
    const [baseline, candidate] = adapter.requests;
    expect(baseline?.installedPaths).toEqual([]);
    expect(candidate?.installedPaths).toEqual(['.agent/skill.md']);
    expect(candidate?.workspace).toBe(pins[0]);
    expect(candidate?.workspace).toMatchObject({
      path: expect.stringMatching(/candidate-1[/\\]workspace$/) as string,
      canonical: realpathSync(candidate?.workspace.path as string),
    });
    expect(candidate?.scratchDir).toMatch(/candidate-1[/\\]agent$/);
    expect(scratch).toEqual([[], []]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a workspace a setup command replaced, before installing or running the agent',
    async () => {
      // Moves the workspace away and leaves a link to another directory at its path; the second
      // command must never run in the replacement (Codex review).
      const marker = join(tmp('marker'), 'second-ran');
      const input = await suite({
        cases: [
          testCase({
            setup: [
              [
                'sh',
                '-c',
                'cd .. && mv workspace moved && mkdir elsewhere && ln -s "$PWD/elsewhere" workspace',
              ],
              nodeScript(`require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`),
            ],
          }),
        ],
      });
      const adapter = new FakeAdapter();
      let installs = 0;
      adapter.install = async () => {
        installs += 1;
        return { paths: [] };
      };
      const records: AgentRunRecord[] = [];
      const stopped = await runBenchmark({
        ...input,
        adapter,
        signal: signal(),
        onAgentRun: async (record) => {
          records.push(record);
        },
      }).catch((error: unknown) => error);
      // A stop code (FR-118-15): the second agent run never starts.
      expect(stopped).toBeInstanceOf(BenchmarkStoppedError);
      expect(stopped).toMatchObject({ code: 'workspace-replaced' });
      expect(records.map((run) => [run.executionStatus, run.errorCode, run.error])).toEqual([
        [
          'infrastructure-error',
          'workspace-replaced',
          'workspace-replaced: the workspace path is no longer a directory after setup.',
        ],
      ]);
      expect(installs).toBe(0);
      expect(adapter.requests).toHaveLength(0);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills a background process of a setup command before installation (SPEC-118 §12)',
    async () => {
      // Without the kill, the background child would write configuration after the checks.
      const late =
        '(sleep 1; mkdir -p .claude; echo late > .claude/settings.local.json) > /dev/null 2>&1 < /dev/null &';
      const input = await suite({ cases: [testCase({ setup: [['sh', '-c', late]] })] });
      const adapter = new FakeAdapter(async (request, variant) => {
        // Give the background child time to write, had it survived setup.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        writeFileSync(join(request.workspace.path, 'out.txt'), variant);
        return completed();
      });
      const outcome = await runBenchmark({
        ...input,
        adapter,
        keepWorkspaces: true,
        signal: signal(),
      });
      for (const request of adapter.requests) {
        expect(existsSync(join(request.workspace.path, '.claude'))).toBe(false);
      }
      expect(outcome.agentRuns.map((run) => run.executionStatus)).toEqual([
        'completed',
        'completed',
      ]);
    },
    20_000,
  );

  it('stops the benchmark when a setup command leaves processes that cannot be stopped (FR-118-15)', async () => {
    const input = await suite({
      cases: [testCase({ setup: [nodeScript('process.exit(0)')] })],
    });
    const adapter = new FakeAdapter();
    const records: AgentRunRecord[] = [];
    strayGroup.survives = true;
    let stopped: unknown;
    try {
      await runBenchmark({
        ...input,
        adapter,
        signal: signal(),
        onAgentRun: async (record) => {
          records.push(record);
        },
      });
    } catch (error) {
      stopped = error;
    } finally {
      strayGroup.survives = false;
    }
    expect(stopped).toBeInstanceOf(BenchmarkStoppedError);
    expect(stopped).toMatchObject({ code: 'stray-processes' });
    // Only the first agent run's setup ran; nothing after it.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      executionStatus: 'infrastructure-error',
      errorCode: 'stray-processes',
      error: expect.stringMatching(
        /^Setup command left processes that could not be stopped: /,
      ) as string,
    });
    expect(adapter.requests).toHaveLength(0);
  });

  it('stops the benchmark when an assertion command leaves processes that cannot be stopped (Codex review)', async () => {
    const input = await suite({
      cases: [
        testCase({
          assertions: [
            { id: 'leaves', type: 'command', command: nodeScript('process.exit(0)') },
            { id: 'next', type: 'file-exists', path: 'hidden.txt' },
          ],
        }),
      ],
    });
    const adapter = new FakeAdapter();
    const records: AgentRunRecord[] = [];
    strayGroup.survives = true;
    let stopped: unknown;
    try {
      await runBenchmark({
        ...input,
        adapter,
        signal: signal(),
        onAgentRun: async (record) => {
          records.push(record);
        },
      });
    } catch (error) {
      stopped = error;
    } finally {
      strayGroup.survives = false;
    }
    expect(stopped).toMatchObject({ code: 'stray-processes' });
    expect(adapter.requests).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      executionStatus: 'infrastructure-error',
      errorCode: 'stray-processes',
      error: 'Assertion command left processes that could not be stopped: leaves',
      score: null,
    });
    // The next assertion never ran.
    expect(records[0]?.assertions.map((a) => a.assertionId)).toEqual(['leaves']);
  });

  it.skipIf(process.platform === 'win32')(
    'stops when a command assertion replaces the workspace; the next one never runs in it (Codex review)',
    async () => {
      const victim = tmp('victim');
      const input = await suite({
        cases: [
          testCase({
            assertions: [
              {
                id: 'replaces',
                type: 'command',
                command: [
                  'sh',
                  '-c',
                  `mv "$PWD" "$PWD.saved" && ln -s ${JSON.stringify(victim)} "$PWD"`,
                ],
              },
              { id: 'writes', type: 'command', command: ['sh', '-c', 'touch marker'] },
            ],
          }),
        ],
      });
      const records: AgentRunRecord[] = [];
      const stopped = await runBenchmark({
        ...input,
        adapter: new FakeAdapter(),
        signal: signal(),
        onAgentRun: async (record) => {
          records.push(record);
        },
      }).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ code: 'workspace-replaced' });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        executionStatus: 'infrastructure-error',
        errorCode: 'workspace-replaced',
        error: expect.stringMatching(
          /^workspace-replaced: .* after assertion replaces\.$/,
        ) as string,
      });
      expect(records[0]?.assertions.map((a) => a.assertionId)).toEqual(['replaces']);
      expect(readdirSync(victim)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'stops when the agent replaces the workspace, before the overlay is copied (Codex review)',
    async () => {
      const victim = tmp('victim');
      const input = await suite();
      const adapter = new FakeAdapter(async (request) => {
        renameSync(request.workspace.path, `${request.workspace.path}.saved`);
        symlinkSync(victim, request.workspace.path);
        return completed();
      });
      const stopped = await runBenchmark({ ...input, adapter, signal: signal() }).catch(
        (error: unknown) => error,
      );
      expect(stopped).toMatchObject({
        code: 'workspace-replaced',
        message: expect.stringContaining('after the agent run.') as string,
      });
      expect(readdirSync(victim)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32').each([
    ['agent-error', undefined, 'workspace-replaced'],
    ['timeout', undefined, 'workspace-replaced'],
    // A code that already stops the run keeps precedence.
    ['agent-error', 'auth-expired', 'auth-expired'],
  ] as const)(
    'stops when a %s agent run replaced the workspace (Codex review, code %s)',
    async (status, errorCode, stopCode) => {
      const victim = tmp('victim');
      const input = await suite();
      const adapter = new FakeAdapter(async (request) => {
        renameSync(request.workspace.path, `${request.workspace.path}.saved`);
        symlinkSync(victim, request.workspace.path);
        return completed({ status, error: 'failed', ...(errorCode ? { errorCode } : {}) });
      });
      const records: AgentRunRecord[] = [];
      const stopped = await runBenchmark({
        ...input,
        adapter,
        signal: signal(),
        onAgentRun: async (record) => {
          records.push(record);
        },
      }).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ code: stopCode });
      expect(records).toHaveLength(1);
      expect(adapter.requests).toHaveLength(1);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'stops when the adapter replaced the workspace and then threw (Codex review)',
    async () => {
      const victim = tmp('victim');
      const input = await suite();
      const adapter = new FakeAdapter(async (request) => {
        renameSync(request.workspace.path, `${request.workspace.path}.saved`);
        symlinkSync(victim, request.workspace.path);
        throw new Error('adapter crashed');
      });
      const records: AgentRunRecord[] = [];
      const stopped = await runBenchmark({
        ...input,
        adapter,
        signal: signal(),
        onAgentRun: async (record) => {
          records.push(record);
        },
      }).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ code: 'workspace-replaced' });
      expect(records[0]?.error).toMatch(
        /^workspace-replaced: .* after an error \(adapter crashed\)\.$/,
      );
      expect(adapter.requests).toHaveLength(1);
    },
  );

  it.skipIf(process.platform === 'win32')(
    "keeps an installation's own stop code when it replaced the workspace and threw",
    async () => {
      const victim = tmp('victim');
      const input = await suite();
      const adapter = new FakeAdapter();
      adapter.install = async (workspaceDir) => {
        renameSync(workspaceDir, `${workspaceDir}.saved`);
        symlinkSync(victim, workspaceDir);
        throw new ClaudeCodeError('workspace-replaced', 'refused by the installation');
      };
      const records: AgentRunRecord[] = [];
      const stopped = await runBenchmark({
        ...input,
        adapter,
        signal: signal(),
        onAgentRun: async (record) => {
          records.push(record);
        },
      }).catch((error: unknown) => error);
      expect(stopped).toMatchObject({ code: 'workspace-replaced' });
      expect(records.at(-1)?.error).toBe('refused by the installation');
    },
  );

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

describe('cancellation before the agent starts', () => {
  it('does not start the agent when cancelled while the artifact was installed', async () => {
    const input = await suite();
    const controller = new AbortController();
    const adapter = new FakeAdapter();
    const install = adapter.install;
    adapter.install = async (workspaceDir) => {
      controller.abort();
      return install(workspaceDir);
    };
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
    expect(records.map((r) => [r.variant, r.executionStatus, r.error])).toEqual([
      ['baseline', 'completed', null],
      ['candidate', 'cancelled', 'Cancelled'],
    ]);
    // Only the baseline reached the agent; it finished before the cancellation.
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.signal.aborted).toBe(false);
  });
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

describe('assertions that cannot finish (SPEC-118 FR-118-46)', () => {
  /** The candidate writes text on which `(a+)+$` backtracks for minutes. */
  const writeAdversarial: RunHandler = async (request, variant) => {
    writeFileSync(
      join(request.workspace.path, 'out.txt'),
      variant === 'candidate' ? `${'a'.repeat(32)}!` : 'b',
    );
    return completed({ usage: { inputTokens: 1, outputTokens: 1 } });
  };
  const adversarialCase = () =>
    testCase({
      verification: undefined,
      assertions: [
        { id: 'present', type: 'file-exists', path: 'out.txt' },
        { id: 'pattern', type: 'file-contains', path: 'out.txt', pattern: '(a+)+$' },
      ],
    });

  it('makes the agent run an infrastructure error and keeps the assertion results', async () => {
    const input = await suite({ cases: [adversarialCase()] });
    const outcome = await runBenchmark({
      ...input,
      adapter: new FakeAdapter(writeAdversarial),
      signal: signal(),
    });
    const candidate = outcome.agentRuns.find((r) => r.variant === 'candidate');
    expect(candidate).toMatchObject({
      executionStatus: 'infrastructure-error',
      score: null,
      passed: null,
      errorCode: 'assertion-error',
      error:
        'assertion-error: assertion "pattern" could not be evaluated: Pattern evaluation exceeded 2000 ms; simplify the regular expression',
      changedFiles: [{ path: 'out.txt', change: 'added' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(candidate?.assertions.map((a) => [a.assertionId, a.passed, a.error?.code])).toEqual([
      ['present', true, undefined],
      ['pattern', false, 'pattern-timeout'],
    ]);
    expect(candidate?.assertions[1]?.details).toMatchObject({
      error: { code: 'pattern-timeout' },
      patterns: ['/(a+)+$/'],
    });
    const baseline = outcome.agentRuns.find((r) => r.variant === 'baseline');
    expect(baseline).toMatchObject({ executionStatus: 'completed', score: 0.5 });
    // Excluded from quality: the candidate has no valid run, so there is no verdict.
    expect(outcome.summary.verdict).toBe('error');
  }, 20_000);

  it('terminates a running pattern on cancellation and records the run as cancelled', async () => {
    const input = await suite({ cases: [adversarialCase()] });
    const controller = new AbortController();
    let agentFinished = 0;
    const adapter = new FakeAdapter(async (request, variant) => {
      const result = await writeAdversarial(request, variant);
      if (variant === 'candidate') {
        agentFinished = performance.now();
        setTimeout(() => controller.abort(), 200);
      }
      return result;
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
    expect(records.map((r) => [r.variant, r.executionStatus, r.error])).toEqual([
      ['baseline', 'completed', null],
      ['candidate', 'cancelled', 'Cancelled during assertions'],
    ]);
    // The worker stopped with the cancellation, well before the 2 s pattern deadline.
    expect(performance.now() - agentFinished).toBeLessThan(1800);
  }, 20_000);
});

describe('output files (SPEC-123 Phase 1)', () => {
  type Delivered = { record: AgentRunRecord; capture: OutputFilesCapture | null };
  const collect =
    (delivered: Delivered[]) =>
    async (record: AgentRunRecord, capture: OutputFilesCapture | null) => {
      delivered.push({ record, capture });
    };
  const notKept = (reason: string) => ({
    status: 'not-kept',
    reason,
    files: 0,
    truncated: 0,
    notKept: 0,
    storedBytes: 0,
  });

  it('captures before the overlay and delivers the content beside a metadata-only record (FR-123-01/10)', async () => {
    const input = await suite();
    const delivered: Delivered[] = [];
    const outcome = await runBenchmark({
      ...input,
      adapter: new FakeAdapter(),
      signal: signal(),
      onAgentRun: collect(delivered),
    });
    expect(delivered.map((d) => d.capture)).toEqual([
      {
        files: [
          {
            path: 'out.txt',
            change: 'added',
            sizeBytes: 8,
            sha256: expect.any(String),
            kept: 'full',
            reason: null,
            content: 'baseline',
            storedBytes: 8,
            redactions: 0,
          },
        ],
      },
      { files: [expect.objectContaining({ path: 'out.txt', content: 'candidate' })] },
    ]);
    // The overlay (hidden.txt) and the installed artifact are not output of the agent.
    for (const record of outcome.agentRuns) {
      expect(record.outputFiles).toEqual({
        status: 'kept',
        reason: null,
        files: 1,
        truncated: 0,
        notKept: 0,
        storedBytes: record.variant === 'baseline' ? 8 : 9,
      });
      // Records hold metadata only (AC-10).
      expect(JSON.stringify(record)).not.toMatch(/"content"/);
    }
    expect(delivered.map((d) => d.record)).toEqual(outcome.agentRuns);
  });

  it('captures nothing without onAgentRun, and scores identically either way (AC-9)', async () => {
    const input = await suite();
    const without = await runBenchmark({ ...input, adapter: new FakeAdapter(), signal: signal() });
    const withCapture = await runBenchmark({
      ...input,
      workRoot: join(tmp('work'), 'run'),
      adapter: new FakeAdapter(),
      signal: signal(),
      onAgentRun: async () => {},
    });
    expect(without.agentRuns.map((r) => r.outputFiles)).toEqual([NOT_CAPTURED, NOT_CAPTURED]);
    // Durations are the only values that may differ between two runs.
    const withoutDurations = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value, (key, item: unknown) => (/DurationMs$/.test(key) ? 0 : item)),
      );
    const measured = (o: typeof without) => ({
      summary: withoutDurations(o.summary),
      warnings: o.warnings,
      runs: o.agentRuns.map((r) => [
        r.executionStatus,
        r.score,
        r.passed,
        r.changedFiles,
        r.assertions.map((a) => [a.assertionId, a.passed, a.score]),
      ]),
    });
    expect(measured(withCapture)).toEqual(measured(without));
  });

  it('keeps the files of agent-error and timeout runs and stores their change list (FR-123-02/03)', async () => {
    const input = await suite();
    const adapter = new FakeAdapter(async (request, variant) => {
      writeFileSync(join(request.workspace.path, 'partial.txt'), `${variant} partial`);
      return variant === 'baseline'
        ? completed({ status: 'agent-error', error: 'crashed' })
        : completed({ status: 'timeout', error: 'exceeded' });
    });
    const delivered: Delivered[] = [];
    const outcome = await runBenchmark({
      ...input,
      adapter,
      signal: signal(),
      onAgentRun: collect(delivered),
    });
    expect(outcome.agentRuns.map((r) => [r.executionStatus, r.score, r.changedFiles])).toEqual([
      ['agent-error', null, [{ path: 'partial.txt', change: 'added' }]],
      ['timeout', null, [{ path: 'partial.txt', change: 'added' }]],
    ]);
    expect(delivered.map((d) => d.capture?.files.map((f) => f.content))).toEqual([
      ['baseline partial'],
      ['candidate partial'],
    ]);
    // Without a consumer nothing is captured and the change list stays empty, as before.
    const plain = await runBenchmark({
      ...input,
      workRoot: join(tmp('work'), 'run'),
      adapter,
      signal: signal(),
    });
    expect(plain.agentRuns.map((r) => r.changedFiles)).toEqual([[], []]);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps an agent-error run unchanged when its own manifest fails (FR-123-09)',
    async () => {
      const input = await suite();
      const adapter = new FakeAdapter(async (request) => {
        symlinkSync('/etc', join(request.workspace.path, 'link'));
        return completed({ status: 'agent-error', error: 'crashed' });
      });
      const delivered: Delivered[] = [];
      await runBenchmark({ ...input, adapter, signal: signal(), onAgentRun: collect(delivered) });
      expect(delivered[0]?.record).toMatchObject({
        executionStatus: 'agent-error',
        error: 'crashed',
        changedFiles: [],
        outputFiles: notKept('Symbolic links are not allowed: link'),
      });
      expect(delivered[0]?.capture).toBeNull();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps no files when the agent of a completed run left a link: the run is an infrastructure error (FR-123-02)',
    async () => {
      const input = await suite();
      const adapter = new FakeAdapter(async (request) => {
        symlinkSync('/etc', join(request.workspace.path, 'link'));
        return completed();
      });
      const delivered: Delivered[] = [];
      await runBenchmark({ ...input, adapter, signal: signal(), onAgentRun: collect(delivered) });
      expect(delivered[0]?.record).toMatchObject({
        executionStatus: 'infrastructure-error',
        outputFiles: notKept(OUTPUT_NOT_CAPTURED_REASON),
      });
      expect(delivered[0]?.capture).toBeNull();
    },
  );

  it('records a capture failure without changing the measurement (FR-123-09)', async () => {
    const input = await suite();
    const adapter = new FakeAdapter();
    adapter.findOutputSecrets = () => [{ start: 0, end: 10_000 }];
    const delivered: Delivered[] = [];
    const outcome = await runBenchmark({
      ...input,
      adapter,
      signal: signal(),
      onAgentRun: collect(delivered),
    });
    expect(outcome.agentRuns.map((r) => [r.executionStatus, r.score, r.changedFiles])).toEqual([
      ['completed', 2 / 3, [{ path: 'out.txt', change: 'added' }]],
      ['completed', 1, [{ path: 'out.txt', change: 'added' }]],
    ]);
    // The reason cannot be redacted by this adapter either, so it is generic.
    expect(outcome.agentRuns[0]?.outputFiles).toEqual(
      notKept('the output files could not be captured'),
    );
    expect(delivered.map((d) => d.capture)).toEqual([null, null]);
  });

  it.each([
    ['cancelled', undefined],
    ['infrastructure-error', undefined],
    ['agent-error', 'auth-expired'],
  ] as const)('captures nothing for an adapter result %s (code %s)', async (status, errorCode) => {
    const input = await suite();
    const adapter = new FakeAdapter(async (request, variant) => {
      await writeVariant(request, variant);
      return completed({ status, error: 'failed', ...(errorCode ? { errorCode } : {}) });
    });
    const delivered: Delivered[] = [];
    await runBenchmark({
      ...input,
      adapter,
      signal: signal(),
      onAgentRun: collect(delivered),
    }).catch(() => undefined);
    expect(delivered[0]?.record.outputFiles).toEqual(notKept(OUTPUT_NOT_CAPTURED_REASON));
    expect(delivered[0]?.record.changedFiles).toEqual([]);
    expect(delivered[0]?.capture).toBeNull();
  });

  it('captures nothing when the run was cancelled while the agent worked', async () => {
    const input = await suite();
    const controller = new AbortController();
    const adapter = new FakeAdapter(async (request, variant) => {
      controller.abort();
      return writeVariant(request, variant);
    });
    const delivered: Delivered[] = [];
    await runBenchmark({
      ...input,
      adapter,
      signal: controller.signal,
      onAgentRun: collect(delivered),
    }).catch(() => undefined);
    expect(delivered[0]?.record.outputFiles).toEqual(notKept(OUTPUT_NOT_CAPTURED_REASON));
    expect(delivered[0]?.capture).toBeNull();
  });

  it('captures nothing from an agent that did not stop after its timeout', async () => {
    const input = await suite({
      execution: { agent: 'fake', timeoutSeconds: 0.05, repetitions: 1 },
    });
    const adapter = new FakeAdapter((request, variant) =>
      variant === 'baseline'
        ? new Promise<AgentRunResult>(() => {})
        : writeVariant(request, variant),
    );
    const delivered: Delivered[] = [];
    await runBenchmark({ ...input, adapter, signal: signal(), onAgentRun: collect(delivered) });
    expect(delivered[0]?.record.outputFiles).toEqual(
      notKept('the agent did not stop after its timeout'),
    );
    expect(delivered[0]?.capture).toBeNull();
    expect(delivered[1]?.record.outputFiles.status).toBe('kept');
  }, 20_000);

  it.skipIf(process.platform === 'win32')(
    'captures nothing from a workspace the agent replaced',
    async () => {
      const victim = tmp('victim');
      writeFileSync(join(victim, 'host.txt'), 'host file');
      const input = await suite();
      const adapter = new FakeAdapter(async (request) => {
        renameSync(request.workspace.path, `${request.workspace.path}.saved`);
        symlinkSync(victim, request.workspace.path);
        return completed();
      });
      const delivered: Delivered[] = [];
      await runBenchmark({
        ...input,
        adapter,
        signal: signal(),
        onAgentRun: collect(delivered),
      }).catch(() => undefined);
      expect(delivered[0]?.record.outputFiles).toEqual(
        notKept('the workspace was replaced during the agent run'),
      );
      expect(delivered[0]?.capture).toBeNull();
    },
  );

  it('keeps the files of an assertion-error run (A6, AC-11)', async () => {
    const input = await suite({
      cases: [
        testCase({
          verification: undefined,
          assertions: [
            { id: 'pattern', type: 'file-contains', path: 'out.txt', pattern: '(a+)+$' },
          ],
        }),
      ],
    });
    const adapter = new FakeAdapter(async (request) => {
      writeFileSync(join(request.workspace.path, 'out.txt'), `${'a'.repeat(32)}!`);
      return completed();
    });
    const delivered: Delivered[] = [];
    await runBenchmark({ ...input, adapter, signal: signal(), onAgentRun: collect(delivered) });
    expect(delivered[0]?.record).toMatchObject({
      executionStatus: 'infrastructure-error',
      errorCode: 'assertion-error',
      outputFiles: { status: 'kept', files: 1 },
    });
    expect(delivered[0]?.capture?.files[0]?.content).toBe(`${'a'.repeat(32)}!`);
  }, 20_000);

  it('keeps the files when an assertion command leaves processes or replaces the workspace (A6)', async () => {
    const strayInput = await suite({
      cases: [
        testCase({
          assertions: [{ id: 'leaves', type: 'command', command: nodeScript('process.exit(0)') }],
        }),
      ],
    });
    const delivered: Delivered[] = [];
    strayGroup.survives = true;
    try {
      await runBenchmark({
        ...strayInput,
        adapter: new FakeAdapter(),
        signal: signal(),
        onAgentRun: collect(delivered),
      }).catch(() => undefined);
    } finally {
      strayGroup.survives = false;
    }
    expect(delivered[0]?.record).toMatchObject({
      errorCode: 'stray-processes',
      outputFiles: { status: 'kept', files: 1 },
    });
    expect(delivered[0]?.capture?.files[0]?.content).toBe('baseline');
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the files when an assertion command replaced the workspace (A6)',
    async () => {
      const victim = tmp('victim');
      const input = await suite({
        cases: [
          testCase({
            assertions: [
              {
                id: 'replaces',
                type: 'command',
                command: [
                  'sh',
                  '-c',
                  `mv "$PWD" "$PWD.saved" && ln -s ${JSON.stringify(victim)} "$PWD"`,
                ],
              },
            ],
          }),
        ],
      });
      const delivered: Delivered[] = [];
      await runBenchmark({
        ...input,
        adapter: new FakeAdapter(),
        signal: signal(),
        onAgentRun: collect(delivered),
      }).catch(() => undefined);
      expect(delivered[0]?.record).toMatchObject({
        errorCode: 'workspace-replaced',
        outputFiles: { status: 'kept', files: 1 },
      });
      expect(delivered[0]?.capture?.files[0]?.content).toBe('baseline');
    },
  );

  it('keeps the files when the run is cancelled during assertions (A6)', async () => {
    const input = await suite({
      cases: [
        testCase({
          verification: undefined,
          assertions: [
            { id: 'slow', type: 'command', command: nodeScript('setTimeout(() => {}, 30000)') },
          ],
        }),
      ],
    });
    const controller = new AbortController();
    const adapter = new FakeAdapter(async (request, variant) => {
      setTimeout(() => controller.abort(), 300);
      return writeVariant(request, variant);
    });
    const delivered: Delivered[] = [];
    await runBenchmark({
      ...input,
      adapter,
      signal: controller.signal,
      onAgentRun: collect(delivered),
    }).catch(() => undefined);
    expect(delivered[0]?.record).toMatchObject({
      executionStatus: 'cancelled',
      outputFiles: { status: 'kept', files: 1 },
    });
    expect(delivered[0]?.capture?.files[0]?.content).toBe('baseline');
  }, 20_000);

  it('releases each capture once its callback resolved while the run goes on (FR-123-10, AC-10)', async () => {
    const input = await suite({
      execution: { agent: 'fake', timeoutSeconds: 30, repetitions: 3 },
    });
    const refs: WeakRef<OutputFilesCapture>[] = [];
    const alive: number[] = [];
    await runBenchmark({
      ...input,
      adapter: new FakeAdapter(),
      signal: signal(),
      onAgentRun: async (_record, capture) => {
        // Every earlier capture must be collectable by now.
        await collectGarbage();
        alive.push(refs.filter((ref) => ref.deref() !== undefined).length);
        refs.push(new WeakRef(capture as OutputFilesCapture));
      },
    });
    expect(alive).toEqual([0, 0, 0, 0, 0, 0]);
  }, 20_000);
});
