import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockAgentAdapter } from '@directivebench/agent-adapters';
import { loadLocalArtifact, type ArtifactBundle } from '@directivebench/core';
import {
  BenchmarkCancelledError,
  BenchmarkConfigurationError,
  buildCommandEnv,
  buildManifest,
  diffManifests,
  equivalenceIssues,
  executionBlockers,
  loadDefinitionFile,
  parseDefinitionText,
  prepareSuiteImport,
  runBenchmark,
  runCommand,
  snapshotDirectory,
  type BenchmarkDefinition,
} from '../src/index';

const examples = fileURLToPath(new URL('../../../examples', import.meta.url));
const exampleSuite = join(examples, 'benchmarks/mock-input-validation/benchmark.yaml');

async function exampleArtifact(): Promise<ArtifactBundle> {
  const loaded = await loadLocalArtifact(
    join(examples, 'artifacts'),
    'validate-external-input/SKILL.md',
  );
  return {
    artifactId: 'art_test',
    versionId: 'artv_test',
    slug: loaded.slug,
    name: loaded.parsed.name,
    type: loaded.parsed.type,
    format: loaded.parsed.format,
    contentHash: loaded.contentHash,
    files: loaded.files,
  };
}

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `directivebench-${prefix}-`));

describe('benchmark definition format', () => {
  it('validates every example definition in the repository', async () => {
    const dirs = readdirSync(join(examples, 'benchmarks'));
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const dir of dirs) {
      const definition = await loadDefinitionFile(
        join(examples, 'benchmarks', dir, 'benchmark.yaml'),
      );
      expect(definition.schemaVersion).toBe(1);
    }
  });

  it('applies defaults', () => {
    const result = parseDefinitionText(
      JSON.stringify({
        schemaVersion: 1,
        id: 'x',
        name: 'X',
        execution: { agent: 'mock' },
        cases: [
          {
            id: 'c',
            name: 'C',
            prompt: 'p',
            fixture: { path: 'f' },
            assertions: [{ id: 'a', type: 'file-exists', path: 'a.txt' }],
          },
        ],
      }),
      'json',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.execution).toMatchObject({
      repetitions: 3,
      timeoutSeconds: 300,
      model: null,
    });
    expect(result.definition.scoring).toEqual({
      passThreshold: 1,
      minDelta: 0.05,
      stabilityThreshold: 0.1,
    });
    expect(result.definition.cases[0]?.assertions[0]).toMatchObject({
      weight: 1,
      required: false,
      exists: true,
    });
  });

  it('reports precise issues for invalid definitions', () => {
    const result = parseDefinitionText(
      `schemaVersion: 1
id: Bad_Id
name: X
execution: { agent: mock, environment: { kind: docker } }
cases:
  - id: c
    name: C
    prompt: p
    fixture: { path: ../outside }
    assertions:
      - { id: a, type: file-contains, path: a, pattern: "(" }
      - { id: a, type: changed-files }
`,
      'yaml',
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'id',
        'cases.0.fixture.path',
        'cases.0.assertions.0.pattern',
        'cases.0.assertions.1',
      ]),
    );
  });

  it('rejects future schema versions and malformed YAML', () => {
    const future = parseDefinitionText('schemaVersion: 99\n', 'yaml');
    expect(future.success === false && future.issues[0]?.message).toMatch(
      /newer than this DirectiveBench/,
    );
    const broken = parseDefinitionText('a: [', 'yaml');
    expect(broken.success === false && broken.issues[0]?.path).toBe('(document)');
  });
});

describe('fixtures and workspaces', () => {
  it('snapshots directories content-addressably and rejects symlinks', async () => {
    const src = tmp('fixture');
    mkdirSync(join(src, 'a'));
    writeFileSync(join(src, 'a/x.txt'), 'x');
    const store = tmp('store');
    const first = await snapshotDirectory(src, store);
    const second = await snapshotDirectory(src, store);
    expect(second).toEqual(first);
    expect(first.fileCount).toBe(1);

    symlinkSync('/etc/passwd', join(src, 'link'));
    await expect(snapshotDirectory(src, store)).rejects.toThrow(/Symbolic links/);
  });

  it('diffs manifests', async () => {
    const dir = tmp('diff');
    writeFileSync(join(dir, 'keep'), '1');
    writeFileSync(join(dir, 'change'), '1');
    writeFileSync(join(dir, 'remove'), '1');
    const before = await buildManifest(dir);
    writeFileSync(join(dir, 'change'), '2');
    writeFileSync(join(dir, 'add'), '1');
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, 'remove'));
    expect(diffManifests(before, await buildManifest(dir))).toEqual([
      { path: 'add', change: 'added' },
      { path: 'change', change: 'modified' },
      { path: 'remove', change: 'deleted' },
    ]);
  });
});

describe('runCommand', () => {
  const base = () => ({
    cwd: tmpdir(),
    env: buildCommandEnv(tmpdir(), { PATH: process.env.PATH, SECRET_TOKEN: 'x' }),
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
  });

  it('runs argv without a shell and does not leak the parent environment', async () => {
    const result = await runCommand(
      [process.execPath, '-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()))'],
      base(),
    );
    expect(result.exitCode).toBe(0);
    const keys = JSON.parse(result.stdout) as string[];
    expect(keys).not.toContain('SECRET_TOKEN');
    expect(keys).toContain('HOME');

    const shell = await runCommand(['echo', '$HOME && whoami'], base());
    expect(shell.stdout.trim()).toBe('$HOME && whoami');
  });

  it.skipIf(process.platform === 'win32')(
    'sends SIGTERM first and SIGKILL only after the grace period (FR-110-08)',
    async () => {
      const graceful = await runCommand(
        [
          process.execPath,
          '-e',
          "process.on('SIGTERM', () => process.exit(7)); setInterval(() => {}, 1000)",
        ],
        { ...base(), timeoutMs: 300, killGraceMs: 5000 },
      );
      expect(graceful).toMatchObject({ timedOut: true, exitCode: 7 });

      const stubborn = await runCommand(
        [process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        { ...base(), timeoutMs: 300, killGraceMs: 300 },
      );
      expect(stubborn).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
      expect(stubborn.durationMs).toBeGreaterThanOrEqual(550);
    },
  );

  it('times out, truncates and reports spawn errors', async () => {
    const slow = await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], {
      ...base(),
      timeoutMs: 200,
    });
    expect(slow.timedOut).toBe(true);
    const loud = await runCommand(
      [process.execPath, '-e', 'process.stdout.write("x".repeat(5000))'],
      base(),
    );
    expect(loud.truncated).toBe(true);
    expect(loud.stdout).toBe(`${'x'.repeat(1024)}\n[truncated ${5000 - 1024} bytes]`);
    const missing = await runCommand(['definitely-not-a-command-xyz'], base());
    expect(missing.error).toBeTruthy();
  });
});

describe('runBenchmark (mock agent, RED/GREEN)', () => {
  it('produces distinct, assertion-backed baseline and candidate results', async () => {
    const store = tmp('store');
    const prepared = await prepareSuiteImport(exampleSuite, store);
    const artifact = await exampleArtifact();
    const recorded: string[] = [];
    const outcome = await runBenchmark({
      definition: prepared.definition,
      fixtures: prepared.fixtures,
      fixtureStore: store,
      artifact,
      adapter: new MockAgentAdapter(),
      workRoot: join(tmp('work'), 'run'),
      executionApproved: true,
      signal: new AbortController().signal,
      onAgentRun: async (r) => {
        recorded.push(`${r.variant}-${r.repetition}`);
      },
    });

    expect(recorded).toEqual([
      'baseline-1',
      'candidate-1',
      'candidate-2',
      'baseline-2',
      'baseline-3',
      'candidate-3',
    ]);
    const { summary } = outcome;
    expect(summary.baseline).toMatchObject({
      meanScore: 0.5,
      passRate: 0,
      errorRate: 0,
      stdDev: null,
    });
    expect(summary.candidate).toMatchObject({ meanScore: 1, passRate: 1, errorRate: 0 });
    expect(summary).toMatchObject({
      delta: 0.5,
      passRateDelta: 1,
      verdict: 'improved',
      candidateOutcome: 'passed',
    });
    expect(summary.confidence.level).toBe('medium');
    expect(summary.cases[0]?.baseline.stdDev).toBe(0);

    const baselineRun = outcome.agentRuns.find((r) => r.variant === 'baseline');
    const byId = Object.fromEntries(
      baselineRun?.assertions.map((a) => [a.assertionId, a.passed]) ?? [],
    );
    expect(byId).toEqual({
      'basic-behaviour': true,
      'rejects-invalid-input': false,
      'explicit-error-type': false,
      scope: true,
    });
    expect(baselineRun?.changedFiles).toEqual([{ path: 'src/parse-age.js', change: 'modified' }]);
    const candidateRun = outcome.agentRuns.find((r) => r.variant === 'candidate');
    expect(candidateRun?.assertions.every((a) => a.passed)).toBe(true);
    // The installed skill is not counted as an agent change.
    expect(candidateRun?.changedFiles.map((c) => c.path)).toEqual(['src/parse-age.js']);
    // Ordered stage events with timestamps (FR-110-15).
    const stages = candidateRun?.trace.flatMap((e) => (e.type === 'stage' ? [e.stage] : []));
    expect(stages).toEqual(['prepare', 'install', 'agent', 'verification', 'assertions']);
    expect(outcome.environment).toMatchObject({
      kind: 'local-process',
      sandboxed: false,
      adapterId: 'mock',
    });
    expect(outcome.warnings.join('\n')).toMatch(/not an AI evaluation/);
  }, 60_000);

  it('refuses unapproved command execution and unsupported environments', async () => {
    const store = tmp('store');
    const prepared = await prepareSuiteImport(exampleSuite, store);
    const input = {
      definition: prepared.definition,
      fixtures: prepared.fixtures,
      fixtureStore: store,
      artifact: await exampleArtifact(),
      adapter: new MockAgentAdapter(),
      workRoot: join(tmp('work'), 'run'),
      signal: new AbortController().signal,
    };
    await expect(runBenchmark({ ...input, executionApproved: false })).rejects.toThrow(
      /not been approved/,
    );
    const docker: BenchmarkDefinition = {
      ...prepared.definition,
      execution: {
        ...prepared.definition.execution,
        environment: { kind: 'docker', image: 'node:24' },
      },
    };
    await expect(
      runBenchmark({ ...input, definition: docker, executionApproved: true }),
    ).rejects.toThrow(BenchmarkConfigurationError);
  });

  it('stops when cancelled', async () => {
    const store = tmp('store');
    const prepared = await prepareSuiteImport(exampleSuite, store);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runBenchmark({
        definition: prepared.definition,
        fixtures: prepared.fixtures,
        fixtureStore: store,
        artifact: await exampleArtifact(),
        adapter: new MockAgentAdapter(),
        workRoot: join(tmp('work'), 'run'),
        executionApproved: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow(BenchmarkCancelledError);
  });
});

describe('execution guards and equivalence', () => {
  it('reports execution blockers shared by the web app and the orchestrator', async () => {
    const definition = await loadDefinitionFile(exampleSuite);
    expect(executionBlockers(definition, true)).toEqual([]);
    expect(executionBlockers(definition, false)).toEqual([
      'This suite version runs commands but has not been approved for execution.',
    ]);
    const docker = {
      ...definition,
      execution: { ...definition.execution, environment: { kind: 'docker' as const, image: 'x' } },
    };
    expect(executionBlockers(docker, true)[0]).toMatch(/not implemented yet/);
  });

  it('detects fixture and agent-version mismatches (FR-112-08)', () => {
    const fixtures = { c: { fixture: 'aaa' } };
    const ok = { caseId: 'c', variant: 'baseline' as const, repetition: 1, fixtureHash: 'aaa' };
    expect(equivalenceIssues(fixtures, [ok], '1.0', '1.0')).toEqual([]);
    expect(
      equivalenceIssues(
        fixtures,
        [ok, { ...ok, variant: 'candidate', fixtureHash: 'bbb' }],
        '1.0',
        '1.1',
      ),
    ).toEqual([
      'case c: candidate repetition 1 used a different fixture snapshot',
      'agent version changed during the run (1.0 → 1.1)',
    ]);
  });

  it('records an infrastructure error when the fixture store was tampered with (FR-110-02)', async () => {
    const store = tmp('store');
    const prepared = await prepareSuiteImport(exampleSuite, store);
    const fixtureHash = prepared.fixtures['implement-parse-age']?.fixture as string;
    writeFileSync(join(store, fixtureHash, 'README.md'), 'tampered');
    const definition = {
      ...prepared.definition,
      execution: { ...prepared.definition.execution, repetitions: 1 },
    };
    const outcome = await runBenchmark({
      definition,
      fixtures: prepared.fixtures,
      fixtureStore: store,
      artifact: await exampleArtifact(),
      adapter: new MockAgentAdapter(),
      workRoot: join(tmp('work'), 'run'),
      executionApproved: true,
      signal: new AbortController().signal,
    });
    expect(outcome.agentRuns.every((r) => r.executionStatus === 'infrastructure-error')).toBe(true);
    expect(outcome.agentRuns[0]?.error).toMatch(/does not match fixture snapshot/);
    expect(outcome.summary.verdict).toBe('error');
  });

  it('rejects a model selection the adapter cannot honour (FR-107-07)', async () => {
    const store = tmp('store');
    const prepared = await prepareSuiteImport(exampleSuite, store);
    const definition = {
      ...prepared.definition,
      execution: { ...prepared.definition.execution, model: { provider: 'anthropic', model: 'x' } },
    };
    await expect(
      runBenchmark({
        definition,
        fixtures: prepared.fixtures,
        fixtureStore: store,
        artifact: await exampleArtifact(),
        adapter: new MockAgentAdapter(),
        workRoot: join(tmp('work'), 'run'),
        executionApproved: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/does not support model selection/);
  });

  it('requires headless execution and artifact installation capabilities', async () => {
    const store = tmp('store');
    const prepared = await prepareSuiteImport(exampleSuite, store);
    const adapter = new MockAgentAdapter();
    Object.defineProperty(adapter, 'capabilities', {
      value: { ...adapter.capabilities, artifactInstallation: false },
    });
    await expect(
      runBenchmark({
        definition: prepared.definition,
        fixtures: prepared.fixtures,
        fixtureStore: store,
        artifact: await exampleArtifact(),
        adapter,
        workRoot: join(tmp('work'), 'run'),
        executionApproved: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/headless execution and artifact installation/);
  });
});
