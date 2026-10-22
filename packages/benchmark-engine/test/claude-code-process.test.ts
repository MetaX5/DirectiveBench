import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgv,
  buildClaudeEnv,
  installClaudeArtifact,
  runClaudeCode,
  type AgentAdapter,
  type AgentRunRequest,
  type AgentRunResult,
  type WorkspacePin,
} from '@directivebench/agent-adapters';
import { hashManifest, sha256, type ArtifactBundle } from '@directivebench/core';
import type { BenchmarkDefinitionInput } from '../src/definition';
import { prepareSuiteImport } from '../src/import';
import { runBenchmark, type AgentRunRecord } from '../src/orchestrator';
import { BenchmarkStoppedError } from '../src/stop';
import { useTempDirs } from './helpers';

/**
 * The engine with the Claude Code installation, pre-spawn inspection and process control of
 * `@directivebench/agent-adapters`, and a fake `claude` that records every start (SPEC-118 §15
 * integration). The stream is not parsed here (#100): a run that exits 0 counts as completed.
 */
const tmp = useTempDirs();
const posix = describe.skipIf(process.platform === 'win32');

function fakeClaude(root: string): { executable: string; starts: () => number } {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'starts.log');
  const executable = join(bin, 'claude');
  writeFileSync(
    executable,
    `#!/bin/sh\necho start >> '${log}'\ncat > /dev/null\nprintf '%s\\n' 'x' > out.txt\nexit 0\n`,
  );
  chmodSync(executable, 0o755);
  return {
    executable,
    starts: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').length - 1 : 0),
  };
}

/** Test adapter: the real install and run steps, a trivial result mapping instead of the parser. */
function claudeAdapter(root: string, executable: string): AgentAdapter {
  const home = join(root, 'home');
  mkdirSync(home);
  return {
    id: 'claude-code',
    displayName: 'Claude Code (fake CLI)',
    capabilities: {
      execution: true,
      headless: true,
      modelSelection: true,
      artifactInstallation: true,
      structuredOutput: true,
      usageReporting: true,
      deterministic: false,
    },
    detect: async () => ({
      adapterId: 'claude-code',
      installed: true,
      version: '2.1.296',
      executablePath: executable,
      auth: 'ready',
      notes: [],
    }),
    installArtifact: (workspace: WorkspacePin, artifact: ArtifactBundle) =>
      installClaudeArtifact(workspace, artifact),
    run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
      const outcome = await runClaudeCode({
        executable,
        argv: buildClaudeArgv({
          authMode: 'subscription',
          permissionProfile: 'edit-only',
          artifact: { format: 'skill-md', skillName: 'pdf' },
          model: null,
        }),
        env: buildClaudeEnv({
          authMode: 'subscription',
          baseEnv: { PATH: '/usr/bin:/bin', HOME: home },
          tempDir: request.scratchDir,
        }),
        workspace: request.workspace,
        installedPaths: request.installedPaths,
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
      const ended = outcome.ended;
      return {
        status: ended ? ended.status : 'completed',
        durationMs: outcome.process?.durationMs ?? 0,
        summary: ended?.message ?? 'done',
        trace: [],
        usage: null,
        error: ended ? `${ended.errorCode}: ${ended.message}` : null,
        ...(ended?.errorCode ? { errorCode: ended.errorCode } : {}),
      };
    },
  };
}

function skill(frontmatter: string): ArtifactBundle {
  const content = `---\nname: pdf\ndescription: d\n${frontmatter}---\nBody\n`;
  const files = [
    { path: 'SKILL.md', content, sha256: sha256(content), size: Buffer.byteLength(content) },
  ];
  return {
    artifactId: 'art_1',
    versionId: 'ver_1',
    slug: 'pdf',
    name: 'pdf',
    type: 'skill',
    format: 'skill-md',
    contentHash: hashManifest(files),
    files,
  };
}

async function suite(root: string, setup: string[][]) {
  const dir = join(root, 'suite');
  mkdirSync(join(dir, 'fixture'), { recursive: true });
  writeFileSync(join(dir, 'fixture/README.md'), 'fixture');
  const testCase: BenchmarkDefinitionInput['cases'][number] = {
    id: 'c',
    name: 'Case',
    prompt: 'Write out.txt',
    fixture: { path: 'fixture' },
    setup,
    assertions: [{ id: 'out', type: 'file-exists', path: 'out.txt' }],
  };
  const definition: BenchmarkDefinitionInput = {
    schemaVersion: 1,
    id: 'suite',
    name: 'Suite',
    artifactTypes: ['skill'],
    execution: { agent: 'claude-code', timeoutSeconds: 30, repetitions: 1 },
    cases: [testCase],
  };
  writeFileSync(join(dir, 'benchmark.json'), JSON.stringify(definition));
  const store = join(root, 'store');
  const prepared = await prepareSuiteImport(join(dir, 'benchmark.json'), store);
  return {
    definition: prepared.definition,
    fixtures: prepared.fixtures,
    fixtureStore: store,
    workRoot: join(root, 'work'),
    executionApproved: true,
    signal: new AbortController().signal,
  };
}

posix('runBenchmark with the Claude Code process layer and a fake claude', () => {
  it('runs claude in both variants of a clean workspace', async () => {
    const root = tmp('claude-engine');
    const fake = fakeClaude(root);
    const outcome = await runBenchmark({
      ...(await suite(root, [])),
      artifact: skill(''),
      adapter: claudeAdapter(root, fake.executable),
    });
    expect(outcome.agentRuns.map((run) => [run.variant, run.executionStatus, run.passed])).toEqual([
      ['baseline', 'completed', true],
      ['candidate', 'completed', true],
    ]);
    expect(fake.starts()).toBe(2);
  });

  it('stops the benchmark run when setup wrote Claude Code configuration, and never starts claude (AC-26, FR-118-15)', async () => {
    const root = tmp('claude-engine');
    const fake = fakeClaude(root);
    const write =
      'mkdir .claude && echo \'{"permissions":{"allow":["Skill"]}}\' > .claude/settings.local.json';
    const records: AgentRunRecord[] = [];
    const adapter = claudeAdapter(root, fake.executable);
    let installs = 0;
    const install = adapter.installArtifact.bind(adapter);
    adapter.installArtifact = (workspace, artifact) => {
      installs += 1;
      return install(workspace, artifact);
    };
    const run = runBenchmark({
      ...(await suite(root, [['sh', '-c', write]])),
      artifact: skill(''),
      adapter,
      onAgentRun: async (record) => {
        records.push(record);
      },
    });
    const stopped = await run.catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(BenchmarkStoppedError);
    expect(stopped).toMatchObject({ code: 'workspace-contains-claude-config' });
    expect((stopped as Error).message).toMatch(
      /^Stopped after case c, baseline repetition 1 \(workspace-contains-claude-config\): /,
    );
    // Only the baseline ran up to the pre-spawn inspection: no candidate setup, install or spawn.
    expect(
      records.map((record) => [record.variant, record.executionStatus, record.errorCode]),
    ).toEqual([['baseline', 'infrastructure-error', 'workspace-contains-claude-config']]);
    expect(installs).toBe(0);
    expect(fake.starts()).toBe(0);
  });

  it('never starts claude for a candidate that executes code (frontmatter hooks)', async () => {
    const root = tmp('claude-engine');
    const fake = fakeClaude(root);
    const outcome = await runBenchmark({
      ...(await suite(root, [])),
      artifact: skill('hooks:\n  PreToolUse: []\n'),
      adapter: claudeAdapter(root, fake.executable),
    });
    const candidate = outcome.agentRuns.find((run) => run.variant === 'candidate');
    expect(candidate?.executionStatus).toBe('infrastructure-error');
    expect(candidate?.error).toMatch(/^The artifact version is refused: SKILL\.md: /);
    // The adapter's refusal code is kept; it is not a stop code, so the run went on.
    expect(candidate?.errorCode).toBe('artifact-executes-code');
    // Only the baseline (no artifact) started claude.
    expect(fake.starts()).toBe(1);
  });
});
