import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MOCK_AGENT_VERSION, MockAgentAdapter } from '@directivebench/agent-adapters';
import { loadLocalArtifact, sha256, type ArtifactBundle } from '@directivebench/core';
import {
  BenchmarkConfigurationError,
  comparabilityKey,
  prepareSuiteImport,
  runBenchmark,
  type AgentProfile,
  type RunBenchmarkInput,
} from '../src/index';
import { useTempDirs } from './helpers';

const examples = fileURLToPath(new URL('../../../examples', import.meta.url));
const exampleSuite = join(examples, 'benchmarks/mock-input-validation/benchmark.yaml');
const tmp = useTempDirs();

/**
 * The comparability key `directivebench demo` stored for the bundled mock example on `main`
 * before SPEC-118 Phase 2 (c7576e6, 2026-10-22). It must never change: a different key would
 * split every existing mock-agent history group (SPEC-118 AC-5, §8.3).
 */
const MOCK_EXAMPLE_KEY = '8212a3ebe5818fbf2413bfd7671874710a362f4f5fde0b20c53f77174a8e0f9f';

/** v2 is the bundled skill; v1 is an earlier revision of it without the directive. */
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
  const content =
    '---\nname: validate-external-input\ndescription: Earlier revision.\n---\n\n# Validate external input\n\nWrite readable code.\n';
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

async function exampleInput(): Promise<Omit<RunBenchmarkInput, 'baselineArtifact'>> {
  const store = tmp('store');
  const prepared = await prepareSuiteImport(exampleSuite, store);
  return {
    definition: prepared.definition,
    fixtures: prepared.fixtures,
    fixtureStore: store,
    artifact: (await versions()).v2,
    adapter: new MockAgentAdapter(),
    workRoot: join(tmp('work'), 'run'),
    executionApproved: true,
    signal: new AbortController().signal,
  };
}

describe('A/B baseline (SPEC-118 FR-118-10…13)', () => {
  it('installs exactly the baseline version into every baseline workspace and the candidate into every candidate workspace', async () => {
    const { v1, v2 } = await versions();
    const input = await exampleInput();
    const outcome = await runBenchmark({
      ...input,
      baselineArtifact: v1,
      keepWorkspaces: true,
    });

    expect(outcome.agentRuns).toHaveLength(6);
    for (const run of outcome.agentRuns) {
      const installed = run.variant === 'baseline' ? v1 : v2;
      const workspace = join(input.workRoot, run.caseId, `${run.variant}-${run.repetition}`);
      // Same convention, paths and procedure for both variants (FR-118-11).
      expect(run.trace).toContainEqual({
        type: 'message',
        text: `Installed artifact files: .agents/skills/${v2.slug}/SKILL.md`,
      });
      const stages = run.trace.flatMap((e) => (e.type === 'stage' ? [e.stage] : []));
      expect(stages).toEqual(['prepare', 'install', 'agent', 'verification', 'assertions']);
      expect(
        readFileSync(join(workspace, 'workspace/.agents/skills', v2.slug, 'SKILL.md'), 'utf8'),
      ).toBe(installed.files[0]?.content);
      // The installed skill is not an agent change in either variant.
      expect(run.changedFiles.map((c) => c.path)).toEqual(['src/parse-age.js']);
    }
    // v1 lacks the directive, so it scores like no artifact; "improved" means v2 beat v1.
    expect(outcome.summary).toMatchObject({ delta: 0.5, verdict: 'improved' });
  }, 60_000);

  it('rejects a baseline of another artifact, with the same content or of another format before any work', async () => {
    const { v1 } = await versions();
    const input = await exampleInput();
    const cases: [Partial<ArtifactBundle>, RegExp][] = [
      [{ artifactId: 'art_other' }, /same artifact/],
      [{ contentHash: input.artifact.contentHash }, /same content/],
      [{ versionId: input.artifact.versionId }, /candidate version itself/],
      [{ format: 'claude-md' }, /same format/],
    ];
    for (const [change, message] of cases) {
      const adapter = new MockAgentAdapter();
      let detected = false;
      adapter.detect = () => {
        detected = true;
        return Promise.reject(new Error('must not be reached'));
      };
      const run = runBenchmark({ ...input, adapter, baselineArtifact: { ...v1, ...change } });
      await expect(run).rejects.toThrow(BenchmarkConfigurationError);
      await expect(run).rejects.toThrow(message);
      expect(detected).toBe(false);
    }
  });
});

describe('comparability key (SPEC-118 §8.3, AC-5)', () => {
  const profile: AgentProfile = {
    authMode: 'api-key',
    isolationProfile: 'isolated',
    permissionProfile: 'edit-only',
    flagsHash: 'flags',
    executionModel: 'claude-sonnet-4-5',
  };

  it('keeps the bundled mock example key byte-identical', async () => {
    const input = await exampleInput();
    expect(comparabilityKey(input.definition, input.fixtures, 'mock', MOCK_AGENT_VERSION)).toBe(
      MOCK_EXAMPLE_KEY,
    );
    const outcome = await runBenchmark(input);
    expect(outcome.comparabilityKey).toBe(MOCK_EXAMPLE_KEY);
    expect(outcome.environment).not.toHaveProperty('agentProfile');
  }, 60_000);

  it('does not depend on the baseline choice', async () => {
    const input = await exampleInput();
    const ab = await runBenchmark({ ...input, baselineArtifact: (await versions()).v1 });
    expect(ab.comparabilityKey).toBe(MOCK_EXAMPLE_KEY);
  }, 60_000);

  it('separates runs whose agent profile differs in any dimension', async () => {
    const { definition, fixtures } = await exampleInput();
    const key = (agentProfile?: AgentProfile) =>
      comparabilityKey(definition, fixtures, 'claude-code', '2.1.0', agentProfile);
    const userProfile: AgentProfile = {
      ...profile,
      authMode: 'subscription',
      isolationProfile: 'user-profile',
      hostId: 'host-a',
    };
    const keys = [
      key(),
      key(profile),
      key({ ...profile, authMode: 'subscription' }),
      key({ ...profile, permissionProfile: 'edit-and-shell' }),
      key({ ...profile, flagsHash: 'other-flags' }),
      key({ ...profile, executionModel: 'claude-opus-4-1' }),
      key(userProfile),
      key({ ...userProfile, hostId: 'host-b' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    // Equal profiles give equal keys, whatever the property order.
    expect(key({ ...userProfile })).toBe(key(userProfile));
  });
});
