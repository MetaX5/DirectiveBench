import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeError,
  MockAgentAdapter,
  type AgentAdapter,
  type AgentRunRequest,
  type AgentRunResult,
} from '@directivebench/agent-adapters';
import { loadLocalArtifact, sha256, type ArtifactBundle } from '@directivebench/core';
import {
  BenchmarkCancelledError,
  BenchmarkStoppedError,
  prepareSuiteImport,
  RESERVED_NAME_CHECK_DIR,
  RESERVED_NAME_CHECK_FAILED,
  RESERVED_NAME_CHECK_PROMPT,
  runBenchmark,
  type ReservedNameCheckRecord,
  type RunBenchmarkInput,
} from '../src/index';
import { useTempDirs } from './helpers';

/**
 * The reserved-name check of an A/B run (SPEC-203 §4.1, SPEC-118 FR-118-08/15, issue 280,
 * ADR-0015): one session without the skill before the first repetition, only when the adapter
 * offers it, fail closed, never scored.
 */
const examples = fileURLToPath(new URL('../../../examples', import.meta.url));
const exampleSuite = join(examples, 'benchmarks/mock-input-validation/benchmark.yaml');
const tmp = useTempDirs();

async function versions(): Promise<{ v1: ArtifactBundle; v2: ArtifactBundle }> {
  const loaded = await loadLocalArtifact(
    join(examples, 'artifacts'),
    'validate-external-input/SKILL.md',
  );
  const v2: ArtifactBundle = {
    artifactId: 'art_skill',
    versionId: 'artv_v2',
    slug: loaded.slug,
    name: loaded.parsed.name,
    type: loaded.parsed.type,
    format: loaded.parsed.format,
    contentHash: loaded.contentHash,
    files: loaded.files,
  };
  const content = '---\nname: validate-external-input\ndescription: Earlier.\n---\n\nOld.\n';
  const v1: ArtifactBundle = {
    ...v2,
    versionId: 'artv_v1',
    contentHash: sha256(content),
    files: [
      { path: 'SKILL.md', sha256: sha256(content), size: Buffer.byteLength(content), content },
    ],
  };
  return { v1, v2 };
}

const COMPLETED: Omit<AgentRunResult, 'durationMs'> = {
  status: 'completed',
  summary: 'OK',
  trace: [],
  usage: { inputTokens: 7100, outputTokens: 4, costUsd: 0.0006 },
  error: null,
  metadata: {
    adapterVersion: '2.1.325 (Claude Code)',
    authMode: 'subscription',
    isolationProfile: 'user-profile',
    permissionProfile: 'edit-only',
    requestedModel: null,
    executionModel: 'claude-test-model',
    reportedModels: ['claude-test-model'],
    auxiliaryModels: [],
    mismatchedMessageModels: [],
    flagsHash: 'flags',
    installedSkillName: 'validate-external-input',
    nameListsReported: true,
  },
};

type CheckAnswer = (request: AgentRunRequest) => Promise<AgentRunResult>;

interface Harness {
  adapter: AgentAdapter;
  /** Requests of the reserved-name check (its fixed prompt). */
  checks: AgentRunRequest[];
  /** Requests of the variants' agent runs. */
  runs: AgentRunRequest[];
}

/** The mock agent, offering the check when `offer` is set, with a scripted check session. */
function harness(
  answer: CheckAnswer = async () => ({ ...COMPLETED, durationMs: 990 }),
  offer: ((artifact: ArtifactBundle) => boolean) | null = () => true,
): Harness {
  const mock = new MockAgentAdapter();
  const checks: AgentRunRequest[] = [];
  const runs: AgentRunRequest[] = [];
  const adapter: AgentAdapter = {
    id: mock.id,
    displayName: mock.displayName,
    capabilities: mock.capabilities,
    detect: () => mock.detect(),
    installArtifact: (workspace, artifact) => mock.installArtifact(workspace, artifact),
    findOutputSecrets: (text, options) => mock.findOutputSecrets(text, options),
    run: (request) => {
      if (request.prompt === RESERVED_NAME_CHECK_PROMPT) {
        checks.push(request);
        return answer(request);
      }
      runs.push(request);
      return mock.run(request);
    },
    ...(offer === null ? {} : { needsReservedNameCheck: offer }),
  };
  return { adapter, checks, runs };
}

async function input(
  adapter: AgentAdapter,
  options: { ab?: boolean; signal?: AbortSignal; keep?: boolean } = {},
): Promise<RunBenchmarkInput & { records: ReservedNameCheckRecord[] }> {
  const store = tmp('store');
  const prepared = await prepareSuiteImport(exampleSuite, store);
  const { v1, v2 } = await versions();
  const records: ReservedNameCheckRecord[] = [];
  return {
    definition: prepared.definition,
    fixtures: prepared.fixtures,
    fixtureStore: store,
    artifact: v2,
    ...(options.ab === false ? {} : { baselineArtifact: v1 }),
    adapter,
    workRoot: join(tmp('work'), 'run'),
    executionApproved: true,
    signal: options.signal ?? new AbortController().signal,
    ...(options.keep ? { keepWorkspaces: true } : {}),
    records,
    onReservedNameCheck: async (record) => {
      records.push(record);
    },
  };
}

function stopped(error: unknown, code: string): BenchmarkStoppedError {
  expect(error).toBeInstanceOf(BenchmarkStoppedError);
  expect(error).toMatchObject({ code });
  const stop = error as BenchmarkStoppedError;
  expect(stop.message).toMatch(/^Stopped by the reserved-name check before any agent run \(/);
  expect(stop.message).toContain('The check is one session without the skill and is not scored.');
  // App-authored copy: no en or em dash (AGENTS.md §7).
  expect(stop.message).not.toMatch(/[–—]/);
  return stop;
}

describe('reserved-name check of an A/B run (issue 280)', () => {
  it('runs one session without the skill before the first repetition, with the variants request', async () => {
    const { adapter, checks, runs } = harness();
    const run = await input(adapter, { keep: true });
    const outcome = await runBenchmark(run);

    expect(checks).toHaveLength(1);
    const check = checks[0] as AgentRunRequest;
    // Nothing installed, in its own empty workspace, with the variants' artifact, model and limits.
    expect(check.installedPaths).toEqual([]);
    expect(check.workspace.path).toBe(join(run.workRoot, RESERVED_NAME_CHECK_DIR, 'workspace'));
    expect(check.scratchDir).toBe(join(run.workRoot, RESERVED_NAME_CHECK_DIR, 'agent'));
    expect(readdirSync(check.workspace.path)).toEqual([]);
    const first = runs[0] as AgentRunRequest;
    expect(check.artifact).toBe(first.artifact);
    expect(check.baselineArtifact).toBe(first.baselineArtifact);
    expect(check.model).toEqual(first.model);
    expect(check.timeoutMs).toBe(first.timeoutMs);
    expect(check.options).toBeUndefined();
    // Never scored: every agent run is a variant's.
    expect(outcome.agentRuns).toHaveLength(runs.length);
    expect(run.records).toEqual([
      {
        status: 'completed',
        errorCode: null,
        error: null,
        durationMs: 990,
        usage: { inputTokens: 7100, outputTokens: 4, costUsd: 0.0006 },
        adapterVersion: '2.1.325 (Claude Code)',
        executionModel: 'claude-test-model',
        passed: true,
      },
    ]);
  }, 60_000);

  it('stops with skill-name-reserved before any variant when the session lists the name', async () => {
    const { adapter, runs } = harness(async () => ({
      ...COMPLETED,
      status: 'infrastructure-error',
      durationMs: 900,
      error: 'Claude Code lists the skill name "validate-external-input" itself.',
      errorCode: 'skill-name-reserved',
    }));
    const run = await input(adapter);
    const error = await runBenchmark(run).catch((caught: unknown) => caught);
    const stop = stopped(error, 'skill-name-reserved');
    expect(stop.message).toContain(
      '(skill-name-reserved): Claude Code lists the skill name "validate-external-input" itself.',
    );
    expect(runs).toEqual([]);
    expect(run.records).toMatchObject([
      { status: 'infrastructure-error', errorCode: 'skill-name-reserved' },
    ]);
    // The check's workspace goes with the run's.
    expect(existsSync(run.workRoot)).toBe(false);
  });

  it('stops with the session own code when the check fails (auth, rate limit)', async () => {
    for (const errorCode of ['auth-expired', 'rate-limited']) {
      const { adapter, runs } = harness(async () => ({
        ...COMPLETED,
        status: 'agent-error',
        durationMs: 10,
        summary: 'Login expired',
        error: null,
        errorCode,
      }));
      const run = await input(adapter);
      const error = await runBenchmark(run).catch((caught: unknown) => caught);
      // No error text: the summary is the detail.
      expect(stopped(error, errorCode).message).toContain(`(${errorCode}): Login expired.`);
      expect(runs).toEqual([]);
    }
  });

  it('fails closed with reserved-name-check-failed when the failure has no code of its own', async () => {
    const { adapter, runs } = harness(async () => ({
      status: 'timeout',
      durationMs: 30_000,
      summary: 'Timed out',
      trace: [],
      usage: null,
      error: 'The agent run timed out',
    }));
    const run = await input(adapter);
    const error = await runBenchmark(run).catch((caught: unknown) => caught);
    expect(stopped(error, RESERVED_NAME_CHECK_FAILED).message).toContain(
      `(${RESERVED_NAME_CHECK_FAILED}): The agent run timed out.`,
    );
    expect(runs).toEqual([]);
    expect(run.records).toEqual([
      {
        status: 'timeout',
        errorCode: null,
        error: 'The agent run timed out',
        durationMs: 30_000,
        usage: null,
        adapterVersion: null,
        executionModel: null,
        passed: false,
      },
    ]);
  });

  it('fails closed when a completed session reported no start (no system/init)', async () => {
    for (const metadata of [undefined, { ...COMPLETED.metadata!, executionModel: null }]) {
      const { adapter, runs } = harness(async () => {
        const result: AgentRunResult = { ...COMPLETED, durationMs: 5 };
        if (metadata === undefined) delete result.metadata;
        else result.metadata = metadata;
        return result;
      });
      const run = await input(adapter);
      const error = await runBenchmark(run).catch((caught: unknown) => caught);
      expect(stopped(error, RESERVED_NAME_CHECK_FAILED).message).toContain(
        'the session did not report its start (system/init), so the names it lists are unknown',
      );
      expect(runs).toEqual([]);
    }
  });

  it('fails closed when the session start did not report the name lists (Codex round 1)', async () => {
    for (const nameListsReported of [false, undefined]) {
      const { adapter, runs } = harness(async () => {
        const metadata = { ...COMPLETED.metadata!, nameListsReported };
        if (nameListsReported === undefined) delete metadata.nameListsReported;
        return { ...COMPLETED, durationMs: 5, metadata };
      });
      const run = await input(adapter);
      const error = await runBenchmark(run).catch((caught: unknown) => caught);
      expect(stopped(error, RESERVED_NAME_CHECK_FAILED).message).toContain(
        'the session start (system/init) did not report the names the agent lists itself, so they cannot be checked',
      );
      expect(runs).toEqual([]);
      expect(run.records).toMatchObject([{ status: 'completed', passed: false }]);
    }
  });

  it('fails closed when the adapter throws, keeping a ClaudeCodeError code', async () => {
    const thrown: [unknown, string][] = [
      [new ClaudeCodeError('auth-missing', 'no key'), 'auth-missing'],
      [new Error('boom'), RESERVED_NAME_CHECK_FAILED],
      ['plain', RESERVED_NAME_CHECK_FAILED],
    ];
    for (const [reason, code] of thrown) {
      const { adapter, runs } = harness(() => Promise.reject(reason));
      const run = await input(adapter);
      const error = await runBenchmark(run).catch((caught: unknown) => caught);
      stopped(error, code);
      expect(runs).toEqual([]);
      // The record keeps the session's own code; the stop code falls back.
      expect(run.records).toMatchObject([
        {
          status: 'infrastructure-error',
          errorCode: code === RESERVED_NAME_CHECK_FAILED ? null : code,
        },
      ]);
    }
  });

  it('records a timeout when the adapter does not return after its own timeout', async () => {
    const { adapter } = harness(() => new Promise<AgentRunResult>(() => undefined));
    const run = await input(adapter);
    run.definition = {
      ...run.definition,
      execution: { ...run.definition.execution, timeoutSeconds: 0.05 },
    };
    // Waits the engine's AGENT_STOP_GRACE_MS after the timeout.
    const error = await runBenchmark(run).catch((caught: unknown) => caught);
    stopped(error, RESERVED_NAME_CHECK_FAILED);
    expect(run.records).toMatchObject([
      { status: 'timeout', error: 'Agent did not stop after timeout' },
    ]);
  }, 30_000);

  it('ends cancelled when the run is cancelled during the check, before any variant', async () => {
    const controller = new AbortController();
    const { adapter, runs } = harness(async (request) => {
      controller.abort();
      expect(request.signal.aborted).toBe(true);
      return { ...COMPLETED, status: 'cancelled', durationMs: 1 };
    });
    const run = await input(adapter, { signal: controller.signal });
    await expect(runBenchmark(run)).rejects.toBeInstanceOf(BenchmarkCancelledError);
    expect(runs).toEqual([]);
    expect(run.records).toMatchObject([{ status: 'cancelled' }]);
  });

  it('starts no check when the run is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter, checks } = harness();
    const run = await input(adapter, { signal: controller.signal });
    await expect(runBenchmark(run)).rejects.toBeInstanceOf(BenchmarkCancelledError);
    expect(checks).toEqual([]);
    expect(run.records).toEqual([]);
  });

  it('runs no check for a none run, an adapter that does not offer it, or an artifact it declines', async () => {
    const cases: [Harness, boolean][] = [
      [harness(), false],
      [harness(undefined, null), true],
      [harness(undefined, () => false), true],
    ];
    for (const [{ adapter, checks, runs }, ab] of cases) {
      const run = await input(adapter, { ab });
      await runBenchmark(run);
      expect(checks).toEqual([]);
      expect(runs.length).toBeGreaterThan(0);
      expect(run.records).toEqual([]);
    }
  }, 60_000);

  it('runs the check without a callback', async () => {
    const { adapter, checks } = harness();
    const run = await input(adapter);
    delete run.onReservedNameCheck;
    await runBenchmark(run);
    expect(checks).toHaveLength(1);
  }, 60_000);
});
