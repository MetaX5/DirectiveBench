import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from '@directivebench/agent-adapters';
import { hashManifest, sha256, type ArtifactBundle } from '@directivebench/core';
import { BenchmarkStoppedError } from '../src/agent-conditions';
import type { BenchmarkDefinitionInput } from '../src/definition';
import { prepareSuiteImport } from '../src/import';
import { runBenchmark, type AgentRunRecord, type RunBenchmarkInput } from '../src/orchestrator';
import { useTempDirs } from './helpers';

/**
 * Issue #117: the #96 end-to-end criteria through `runBenchmark` with the real `ClaudeCodeAdapter`
 * (installation, inspections, argv and environment, process control, stream parser and
 * normalisation) and a fake `claude` on `PATH` that replays the recorded stream fixtures of
 * `@directivebench/agent-adapters` and records every start. No paid or authenticated call.
 */
const tmp = useTempDirs();
const posix = describe.skipIf(process.platform === 'win32');

const STREAMS = join(import.meta.dirname, '../../agent-adapters/test/fixtures/claude-code/2.1.302');
const stream = (name: string) => readFileSync(join(STREAMS, `${name}.ndjson`), 'utf8');
/** A planted key of no known token shape: only the exact-value redaction can remove it. */
const KEY = 'planted-key-5f3a9c1e7b2d4a60';
/** `secret-in-output` with its `sk-ant-` key replaced by the planted one. */
const SECRET_STREAM = (text: string) => text.replaceAll('sk-ant-test-0000000000000000fake', KEY);
const SONNET = 'claude-sonnet-4-5-20250929';
const OPUS = 'claude-opus-4-1-20250805';

interface Start {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

interface Fake {
  binDir: string;
  /** Every print-mode start, in order. */
  starts(): Start[];
}

/**
 * A fake `claude`: `--version` and the readiness probe answer like the CLI; print mode records
 * argv, environment and working directory, reads the prompt, writes `output.md` and replays
 * `streams/<n>.ndjson` for its n-th start (else `streams/default.ndjson`).
 */
function fakeClaude(root: string, streams: Record<string, string>): Fake {
  const binDir = join(root, 'bin');
  const records = join(root, 'records');
  const streamDir = join(root, 'streams');
  for (const dir of [binDir, records, streamDir]) mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(streams)) {
    writeFileSync(join(streamDir, `${name}.ndjson`), text);
  }
  const executable = join(binDir, 'claude');
  writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'case "$1" in',
      "  --version) echo '2.1.302 (Claude Code)'; exit 0 ;;",
      `  --setting-sources|auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0 ;;`,
      'esac',
      `n=$(ls '${records}' | wc -l | tr -d ' ')`,
      'n=$((n + 1))',
      `dir='${records}'/$n`,
      'mkdir "$dir"',
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > "$dir/argv"`,
      'env > "$dir/env"',
      'pwd -P > "$dir/cwd"',
      'cat > /dev/null',
      "printf '# Report\\n' > output.md",
      `if [ -f '${streamDir}'/$n.ndjson ]; then cat '${streamDir}'/$n.ndjson; else cat '${streamDir}/default.ndjson'; fi`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  return {
    binDir,
    starts: () =>
      readdirSync(records)
        .map(Number)
        .sort((a, b) => a - b)
        .map((n) => {
          const read = (name: string) => readFileSync(join(records, String(n), name), 'utf8');
          return {
            argv: read('argv').split('\n').slice(0, -1),
            env: Object.fromEntries(
              read('env')
                .split('\n')
                .filter((line) => line.includes('='))
                .map((line) => [
                  line.slice(0, line.indexOf('=')),
                  line.slice(line.indexOf('=') + 1),
                ]),
            ),
            cwd: read('cwd').trim(),
          };
        }),
  };
}

function artifact(
  files: Record<string, string>,
  overrides: Partial<ArtifactBundle> = {},
): ArtifactBundle {
  const list = Object.entries(files).map(([path, content]) => ({
    path,
    content,
    sha256: sha256(content),
    size: Buffer.byteLength(content),
  }));
  return {
    artifactId: 'art_1',
    versionId: 'ver_2',
    slug: 'pdf',
    name: 'pdf',
    type: 'skill',
    format: 'skill-md',
    contentHash: hashManifest(list),
    files: list,
    ...overrides,
  };
}

const skill = (frontmatter = '', body = 'Use this skill to write reports.\n') =>
  artifact({
    'SKILL.md': `---\nname: pdf\ndescription: Writes reports\n${frontmatter}---\n${body}`,
  });

/** The A/B baseline: an older version of the same skill. */
const olderSkill = (frontmatter = '', extra: Record<string, string> = {}) =>
  artifact(
    { 'SKILL.md': `---\nname: pdf\ndescription: Older\n${frontmatter}---\nOld body\n`, ...extra },
    { versionId: 'ver_1' },
  );

interface SuiteOptions {
  fixture?: Record<string, string>;
  setup?: string[][];
  prompt?: string;
  repetitions?: number;
}

async function suite(root: string, options: SuiteOptions = {}) {
  const dir = join(root, 'suite');
  const fixtureDir = join(dir, 'fixture');
  mkdirSync(fixtureDir, { recursive: true });
  for (const [path, content] of Object.entries(options.fixture ?? { 'README.md': 'fixture\n' })) {
    mkdirSync(join(fixtureDir, path, '..'), { recursive: true });
    writeFileSync(join(fixtureDir, path), content);
  }
  const definition: BenchmarkDefinitionInput = {
    schemaVersion: 1,
    id: 'suite',
    name: 'Suite',
    artifactTypes: ['skill'],
    execution: { agent: 'claude-code', timeoutSeconds: 30, repetitions: options.repetitions ?? 1 },
    cases: [
      {
        id: 'c',
        name: 'Case',
        prompt: options.prompt ?? 'Write output.md',
        fixture: { path: 'fixture' },
        setup: options.setup ?? [],
        assertions: [{ id: 'out', type: 'file-exists', path: 'output.md' }],
      },
    ],
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
    hostId: 'host-1',
    signal: new AbortController().signal,
  };
}

interface Scenario {
  streams?: Record<string, string>;
  suite?: SuiteOptions;
  artifact?: ArtifactBundle;
  baselineArtifact?: ArtifactBundle;
  adapter?: ClaudeCodeAdapterOptions;
  env?: Record<string, string>;
}

/** One benchmark run; resolves to the outcome or the error it rejected with. */
async function scenario(prefix: string, options: Scenario = {}) {
  const root = realpathSync(tmp(prefix));
  const fake = fakeClaude(root, options.streams ?? { default: stream('skill-invoked') });
  const home = join(root, 'user-home');
  mkdirSync(home);
  const env = { PATH: `${fake.binDir}:/usr/bin:/bin`, HOME: home, ...options.env };
  const records: AgentRunRecord[] = [];
  const input: RunBenchmarkInput = {
    ...(await suite(root, options.suite)),
    artifact: options.artifact ?? skill(),
    ...(options.baselineArtifact ? { baselineArtifact: options.baselineArtifact } : {}),
    adapter: new ClaudeCodeAdapter(options.adapter ?? {}, env),
    onAgentRun: async (record) => {
      records.push(record);
    },
  };
  const result = await runBenchmark(input).catch((error: unknown) => error);
  return { root, home, fake, records, result };
}

function stopped(result: unknown, code: string): BenchmarkStoppedError {
  expect(result).toBeInstanceOf(BenchmarkStoppedError);
  expect(result).toMatchObject({ code });
  return result as BenchmarkStoppedError;
}

const outcomeOf = (result: unknown) => {
  if (result instanceof Error) throw result;
  return result as Awaited<ReturnType<typeof runBenchmark>>;
};

const summary = (records: readonly AgentRunRecord[]) =>
  records.map((record) => [record.variant, record.executionStatus, record.errorCode]);

/** The stream of `name` with `permission_denials` replaced by one denied outside edit. */
function withDeniedOutsideEdit(name: string): string {
  return stream(name).replace(
    '"permission_denials": []',
    '"permission_denials": [{"tool_name": "Edit", "tool_use_id": "toolu_x", "tool_input": {"file_path": "/etc/outside.txt"}}]',
  );
}

posix('runBenchmark with ClaudeCodeAdapter and a fake claude (#96 end to end)', () => {
  it('runs both variants in subscription mode and records metadata, activation and warnings', async () => {
    const { fake, records, result, home } = await scenario('cc-subscription', {
      env: {
        ANTHROPIC_API_KEY: KEY,
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        CLAUDE_CODE_USE_VERTEX: '1',
      },
    });
    const outcome = outcomeOf(result);
    expect(summary(records)).toEqual([
      ['baseline', 'completed', null],
      ['candidate', 'completed', null],
    ]);
    expect(outcome.summary.verdict).toBe('not-comparable');
    // A none baseline that invokes the tested skill is no control (FR-118-09 c).
    expect(outcome.summary.reasons[0]).toMatch(/^baseline-invoked-tested-skill: /);
    expect(outcome.environment.agentProfile).toMatchObject({
      authMode: 'subscription',
      isolationProfile: 'user-profile',
      hostId: 'host-1',
      executionModel: SONNET,
    });
    for (const record of records) {
      expect(record.warnings).toContain('ambient-user-config');
      expect(record.metadata?.isolationProfile).toBe('user-profile');
      expect(record.trace[0]).toMatchObject({ type: 'agent-metadata' });
    }
    expect(records[1]?.skillActivation).toEqual({
      loaded: true,
      invoked: true,
      invocations: 1,
      otherSkills: [],
    });
    const starts = fake.starts();
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(start.env.HOME).toBe(home);
      expect(
        Object.keys(start.env).filter((name) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(name)),
      ).toEqual([]);
    }
    // Identical argv in both variants (AC-6), the skill allowed in both.
    expect(starts[0]?.argv).toEqual(starts[1]?.argv);
    expect(starts[0]?.argv).toContain('Skill(pdf)');
  });

  it('API Key Mode: run-local HOME and CLAUDE_CONFIG_DIR, the key in no argv, trace or record (AC-4)', async () => {
    const { root, fake, records, result } = await scenario('cc-api-key', {
      streams: { default: SECRET_STREAM(stream('secret-in-output')) },
      adapter: { authMode: 'api-key' },
      env: { ANTHROPIC_API_KEY: KEY },
    });
    const outcome = outcomeOf(result);
    expect(summary(records)).toEqual([
      ['baseline', 'completed', null],
      ['candidate', 'completed', null],
    ]);
    expect(outcome.environment.agentProfile).toMatchObject({
      authMode: 'api-key',
      isolationProfile: 'isolated',
    });
    const starts = fake.starts();
    expect(starts.map((start) => start.env.HOME)).toEqual([
      join(root, 'work/c/baseline-1/agent/home'),
      join(root, 'work/c/candidate-1/agent/home'),
    ]);
    for (const start of starts) {
      expect(start.env.CLAUDE_CONFIG_DIR).toBe(join(start.env.HOME as string, '.claude'));
      expect(start.env.ANTHROPIC_API_KEY).toBe(KEY);
      expect(start.argv.join('\n')).not.toContain(KEY);
    }
    // The stream echoed the key; neither the outcome nor the persisted records contain it.
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(JSON.stringify(records)).not.toContain(KEY);
    expect(JSON.stringify(records)).toContain('[REDACTED]');
    // The run directories (and the isolated homes) are removed with the run.
    expect(existsSync(join(root, 'work'))).toBe(false);
  });

  it('refuses every FR-118-06 path of a fixture before claude starts, listing each (AC-16)', async () => {
    const paths = [
      '.claude/settings.json',
      '.mcp.json',
      'sub/.claude/rules/x.md',
      '.claude-plugin/plugin.json',
      'CLAUDE.local.md',
      '.worktreeinclude',
      '.claude.json',
    ];
    const { fake, records, result } = await scenario('cc-fixture-config', {
      suite: {
        fixture: { 'CLAUDE.md': 'Plain.\n', ...Object.fromEntries(paths.map((p) => [p, '{}'])) },
      },
    });
    const error = stopped(result, 'workspace-contains-claude-config');
    // The message names the first REFUSAL_FINDINGS_SHOWN findings: a nested path by its first
    // configuration segment (`sub/.claude`).
    for (const path of [...paths.filter((p) => !p.startsWith('sub/')), 'sub/.claude']) {
      expect(error.message).toContain(`${path}: Claude Code configuration is not allowed`);
    }
    expect(summary(records)).toEqual([
      ['baseline', 'infrastructure-error', 'workspace-contains-claude-config'],
    ]);
    expect(fake.starts()).toEqual([]);
  });

  it.each([
    [
      'local settings that allow Skill',
      { '.claude/settings.local.json': '{"permissions":{"allow":["Skill"]}}' },
      'Do it',
    ],
    ['a legacy command and a /x prompt', { '.claude/commands/x.md': 'Run things' }, '/x'],
    [
      'a nested skill and a /x prompt',
      { 'sub/.claude/skills/x/SKILL.md': '---\nname: x\n---\n' },
      '/x',
    ],
  ])('refuses a fixture with %s before claude starts (AC-26)', async (_name, fixture, prompt) => {
    // An approved suite (`executionApproved`) and a none baseline: the pre-spawn check stops it.
    const none = await scenario('cc-fixture-skill', {
      suite: { fixture: { 'README.md': 'x\n', ...fixture }, prompt },
    });
    stopped(none.result, 'workspace-contains-claude-config');
    expect(none.fake.starts()).toEqual([]);
    // A/B: the baseline version's installation meets the fixture's configuration first. A root
    // `.claude` fails the install closed (not a stop code, so every run is refused the same way);
    // a nested one passes the install and is stopped by the pre-spawn check. claude never starts.
    // The plan-time refusal with `fixture-contains-claude-config` is the CLI's (E06-S04).
    const ab = await scenario('cc-fixture-skill-ab', {
      suite: { fixture: { 'README.md': 'x\n', ...fixture }, prompt },
      baselineArtifact: olderSkill(),
    });
    expect(ab.fake.starts()).toEqual([]);
    expect(ab.records.length).toBeGreaterThan(0);
    for (const record of ab.records) {
      expect(['artifact-install-conflict', 'workspace-contains-claude-config']).toContain(
        record.errorCode,
      );
    }
  });

  it('stops when an approved setup command writes Claude Code configuration (AC-26, FR-118-15)', async () => {
    const write =
      'mkdir .claude && echo \'{"permissions":{"allow":["Skill"]}}\' > .claude/settings.local.json';
    const { fake, records, result } = await scenario('cc-setup-config', {
      suite: { setup: [['sh', '-c', write]], repetitions: 2 },
    });
    expect(stopped(result, 'workspace-contains-claude-config').message).toMatch(
      /^Stopped after case c, baseline repetition 1 \(workspace-contains-claude-config\): /,
    );
    expect(summary(records)).toEqual([
      ['baseline', 'infrastructure-error', 'workspace-contains-claude-config'],
    ]);
    expect(fake.starts()).toEqual([]);
  });

  it.each([
    ['frontmatter hooks', 'hooks:\n  Stop: []\n', 'Body\n', 'artifact-executes-code'],
    ['a !` placeholder in prose', '', 'Run !`id` first.\n', 'artifact-executes-code'],
    ['allowed-tools: Skill', 'allowed-tools: Skill\n', 'Body\n', 'artifact-executes-code'],
    [
      'allowed-tools: Skill(other-name)',
      'allowed-tools: Skill(other-name)\n',
      'Body\n',
      'artifact-executes-code',
    ],
    ['allowed-tools: Edit', 'allowed-tools: Edit\n', 'Body\n', 'artifact-executes-code'],
    ['unparsable frontmatter', 'name: [unclosed\n', 'Body\n', 'artifact-executes-code'],
    ['model: opus', 'model: opus\n', 'Body\n', 'artifact-overrides-model'],
    ['context: fork', 'context: fork\n', 'Body\n', 'artifact-overrides-model'],
  ])(
    'never starts claude for a candidate with %s (AC-23, AC-25, FR-118-26)',
    async (_name, frontmatter, body, code) => {
      const { fake, result } = await scenario('cc-bundle', { artifact: skill(frontmatter, body) });
      const outcome = outcomeOf(result);
      // The refusal is not a stop code: every agent run is refused the same way, none starts claude.
      expect(
        outcome.agentRuns.map((run) => [run.variant, run.executionStatus, run.errorCode]),
      ).toEqual([
        ['baseline', 'infrastructure-error', code],
        ['candidate', 'infrastructure-error', code],
      ]);
      expect(outcome.summary.verdict).toBe('error');
      expect(fake.starts()).toEqual([]);
    },
  );

  it.each([
    ['a bundled settings.json', { 'settings.json': '{}' }],
    ['a bundled hooks/ directory', { 'hooks/run.sh': 'echo' }],
    ['a nested .claude directory', { 'docs/.claude/commands/x.md': 'x' }],
    ['a plugin manifest', { '.claude-plugin/plugin.json': '{}' }],
    ['a bundled .mcp.json', { '.mcp.json': '{}' }],
  ])(
    'never starts claude for an A/B baseline version with %s (AC-23, FR-118-26)',
    async (_name, extra) => {
      const { fake, result } = await scenario('cc-baseline-bundle', {
        baselineArtifact: olderSkill('', extra),
      });
      const outcome = outcomeOf(result);
      expect(outcome.agentRuns.map((run) => run.errorCode)).toEqual([
        'artifact-executes-code',
        'artifact-executes-code',
      ]);
      expect(fake.starts()).toEqual([]);
    },
  );

  it('refuses an import chain from a fixture CLAUDE.md to host files before claude starts (AC-27 a)', async () => {
    const root = realpathSync(tmp('cc-host'));
    const hostFile = join(root, 'host-secret.txt');
    writeFileSync(hostFile, 'host secret\n');
    const { fake, result } = await scenario('cc-import-chain', {
      suite: {
        fixture: {
          'CLAUDE.md': 'See @docs/context.md\n',
          'docs/context.md': `Context @${hostFile}\n`,
        },
      },
    });
    const error = stopped(result, 'workspace-imports-outside');
    expect(error.message).toContain(`docs/context.md`);
    expect(error.message).toContain(hostFile);
    expect(fake.starts()).toEqual([]);
  });

  it('refuses a ~ import against the agent HOME (AC-27 a)', async () => {
    const root = realpathSync(tmp('cc-home'));
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'planted-host-file'), 'x');
    const { fake, result } = await scenario('cc-import-home', {
      suite: { fixture: { 'CLAUDE.md': 'Read @~/planted-host-file\n' } },
      env: { HOME: home },
    });
    expect(stopped(result, 'workspace-imports-outside').message).toContain('~/planted-host-file');
    expect(fake.starts()).toEqual([]);
  });

  it('refuses a candidate or baseline bundle file that imports a host file (AC-27 b)', async () => {
    const root = realpathSync(tmp('cc-bundle-host'));
    const hostFile = join(root, 'host.txt');
    writeFileSync(hostFile, 'host\n');
    const importing = { 'reference.md': `Details: @${hostFile}\n` };

    // A/B, baseline first: the baseline version's file is refused before any start.
    const ab = await scenario('cc-bundle-import-ab', {
      baselineArtifact: olderSkill('', importing),
    });
    expect(stopped(ab.result, 'workspace-imports-outside').message).toContain(
      '.claude/skills/pdf/reference.md',
    );
    expect(ab.fake.starts()).toEqual([]);

    // A none baseline has nothing installed and runs; the candidate never starts claude.
    const none = await scenario('cc-bundle-import-none', {
      artifact: artifact({
        'SKILL.md': '---\nname: pdf\ndescription: d\n---\nBody\n',
        ...importing,
      }),
    });
    stopped(none.result, 'workspace-imports-outside');
    expect(summary(none.records)).toEqual([
      ['baseline', 'completed', null],
      ['candidate', 'infrastructure-error', 'workspace-imports-outside'],
    ]);
    expect(none.fake.starts().map((start) => start.cwd)).toEqual([
      expect.stringMatching(/baseline-1[/\\]workspace$/),
    ]);
  });

  it('refuses a setup link to a host file imported by CLAUDE.md before claude starts (AC-27 c)', async () => {
    const root = realpathSync(tmp('cc-link-host'));
    const hostFile = join(root, 'host.txt');
    writeFileSync(hostFile, 'host\n');
    // A hard link passes the engine's workspace snapshot; the pre-spawn scan refuses it.
    const hard = await scenario('cc-import-hardlink', {
      suite: {
        setup: [['sh', '-c', `ln '${hostFile}' linked.md && echo '@linked.md' > CLAUDE.md`]],
      },
    });
    expect(stopped(hard.result, 'workspace-imports-outside').message).toContain('linked.md');
    expect(hard.fake.starts()).toEqual([]);
    // A symbolic link is already refused by the engine's snapshot after installation (every run,
    // not a stop code); the pre-spawn scan would refuse it too.
    const soft = await scenario('cc-import-symlink', {
      suite: {
        setup: [['sh', '-c', `ln -s '${hostFile}' linked.md && echo '@linked.md' > CLAUDE.md`]],
      },
    });
    expect(outcomeOf(soft.result).agentRuns.map((run) => run.error)).toEqual([
      'Symbolic links are not allowed: linked.md',
      'Symbolic links are not allowed: linked.md',
    ]);
    expect(soft.fake.starts()).toEqual([]);
  });

  it('refuses an import inside a fenced code block (AC-27 d)', async () => {
    const root = realpathSync(tmp('cc-fence-host'));
    const hostFile = join(root, 'host.txt');
    writeFileSync(hostFile, 'host\n');
    const { fake, result } = await scenario('cc-import-fence', {
      suite: { fixture: { 'CLAUDE.md': `Example:\n\n\`\`\`\n@${hostFile}\n\`\`\`\n` } },
    });
    expect(stopped(result, 'workspace-imports-outside').message).toContain(hostFile);
    expect(fake.starts()).toEqual([]);
  });

  it('refuses a workspace above WORKSPACE_SCAN_MAX_FILES entries (AC-27)', async () => {
    // Directories: the engine's own snapshot counts files only (at most 5 000), so entries beyond
    // its limit reach the pre-spawn scan as directories.
    const { fake, result } = await scenario('cc-scan-limit', {
      suite: { setup: [['sh', '-c', 'mkdir many && cd many && seq 1 20001 | xargs mkdir']] },
    });
    stopped(result, 'workspace-scan-limit');
    expect(fake.starts()).toEqual([]);
  }, 60_000);

  it('stops with artifact-not-loaded when the candidate session does not list the skill (AC-21)', async () => {
    const { fake, records, result } = await scenario('cc-not-loaded', {
      streams: { default: stream('skill-not-loaded') },
      suite: { repetitions: 2 },
    });
    stopped(result, 'artifact-not-loaded');
    // The none baseline has nothing installed, so rule (a) applies to the candidate only.
    expect(summary(records)).toEqual([
      ['baseline', 'completed', null],
      ['candidate', 'infrastructure-error', 'artifact-not-loaded'],
    ]);
    expect(fake.starts()).toHaveLength(2);
  });

  it('records a denied outside edit as permission-denied (AC-16, FR-118-07)', async () => {
    const { records, result } = await scenario('cc-denied', {
      streams: { default: withDeniedOutsideEdit('skill-invoked') },
    });
    outcomeOf(result);
    const candidate = records.find((record) => record.variant === 'candidate');
    expect(candidate?.executionStatus).toBe('completed');
    expect(candidate?.passed).toBe(true);
    expect(candidate?.warnings).toContain('permission-denied');
    expect(candidate?.trace).toContainEqual({
      type: 'permission-denied',
      tool: 'Edit',
      callId: 'toolu_x',
    });
  });

  it('makes the run not-comparable when the variants ran on different execution models (AC-18)', async () => {
    const { result } = await scenario('cc-models', {
      streams: {
        1: stream('skill-not-invoked'),
        2: stream('skill-not-invoked').replaceAll(SONNET, OPUS),
      },
      baselineArtifact: olderSkill(),
    });
    const outcome = outcomeOf(result);
    expect(outcome.summary.verdict).toBe('not-comparable');
    expect(outcome.summary.reasons).toContain(
      `execution-model-mismatch: agent runs used different execution models (baseline: ${SONNET}; candidate: ${OPUS})`,
    );
  });

  it('makes the run not-comparable when a main-conversation message used another model (AC-25)', async () => {
    const { result } = await scenario('cc-message-model', {
      streams: { 1: stream('skill-not-invoked'), 2: stream('model-mismatch') },
      baselineArtifact: olderSkill(),
    });
    const outcome = outcomeOf(result);
    expect(outcome.summary.verdict).toBe('not-comparable');
    expect(outcome.summary.reasons.join('\n')).toContain(`candidate: ${OPUS}, ${SONNET}`);
  });

  it.each([
    ['rate_limit', 'rate-limited', 'rate-limited'],
    ['an expired login', 'auth-expired', 'auth-expired'],
  ])('stops after %s on the first agent run (AC-17, FR-118-15)', async (_name, fixture, code) => {
    const { fake, records, result } = await scenario('cc-stop', {
      streams: { default: stream(fixture) },
      suite: { repetitions: 3 },
    });
    expect(stopped(result, code).message).toMatch(/No further agent runs were started\.$/);
    expect(summary(records)).toEqual([['baseline', 'agent-error', code]]);
    expect(fake.starts()).toHaveLength(1);
  });

  it('records a parse error and continues (FR-118-15)', async () => {
    const { fake, records, result } = await scenario('cc-continue', {
      streams: { 1: stream('truncated'), default: stream('skill-invoked') },
    });
    outcomeOf(result);
    expect(summary(records)).toEqual([
      ['baseline', 'agent-error', 'output-parse-error'],
      ['candidate', 'completed', null],
    ]);
    expect(fake.starts()).toHaveLength(2);
  });
});
