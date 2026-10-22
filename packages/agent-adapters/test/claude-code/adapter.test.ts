import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_ADAPTER_ID,
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
} from '../../src/claude-code';
import type { AgentRunRequest } from '../../src/contract';
import { pinWorkspace } from '../../src/workspace-pin';
import { writeFakeClaude, type FakeClaude, type FakeClaudeOptions } from './fake-claude';
import { bundle, fixture } from './helpers';

const posix = describe.skipIf(process.platform === 'win32');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A planted key of no known token shape: only the exact-value redaction can remove it. */
const KEY = 'planted-key-5f3a9c1e7b2d4a60';
/** `secret-in-output` with its `sk-ant-` key replaced by the planted one. */
const SECRET_STREAM = (text: string) => text.replaceAll('sk-ant-test-0000000000000000fake', KEY);
const SKILL = bundle('skill-md', { 'SKILL.md': '---\nname: pdf\ndescription: d\n---\nBody\n' });

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-adapter-')));
  roots.push(root);
  return root;
}

interface Harness {
  root: string;
  fake: FakeClaude;
  home: string;
  env: NodeJS.ProcessEnv;
  adapter(options?: ClaudeCodeAdapterOptions, env?: NodeJS.ProcessEnv): ClaudeCodeAdapter;
  request(overrides?: Partial<AgentRunRequest>): Promise<AgentRunRequest>;
}

/** A fake `claude` on `PATH`, a user `HOME` and a fresh pinned workspace per request. */
function harness(fakeOptions: FakeClaudeOptions = {}): Harness {
  const root = tempRoot();
  const fake = writeFakeClaude(root, 'replay', fakeOptions);
  const home = join(root, 'user-home');
  mkdirSync(home);
  // Variables a subscription run must never pass on, and a planted key.
  const env: NodeJS.ProcessEnv = {
    PATH: `${fake.binDir}:/usr/bin:/bin`,
    HOME: home,
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_AUTH_TOKEN: 'token-value',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CONFIG_DIR: join(home, 'elsewhere'),
  };
  let runs = 0;
  return {
    root,
    fake,
    home,
    env,
    adapter: (options = {}, adapterEnv = env) => new ClaudeCodeAdapter(options, adapterEnv),
    request: async (overrides = {}) => {
      runs += 1;
      const workspaceDir = join(root, `workspace-${runs}`);
      const scratchDir = join(root, `scratch-${runs}`);
      mkdirSync(workspaceDir);
      mkdirSync(scratchDir);
      writeFileSync(join(workspaceDir, 'README.md'), 'Plain fixture file.\n');
      return {
        workspace: await pinWorkspace(workspaceDir),
        installedPaths: [],
        scratchDir,
        artifact: SKILL,
        baselineArtifact: null,
        prompt: 'Write output.md',
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        model: null,
        options: undefined,
        ...overrides,
      };
    },
  };
}

describe('ClaudeCodeAdapter options', () => {
  it('declares the SPEC-203 §4.2 capabilities and defaults to subscription, edit-only', () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.id).toBe(CLAUDE_CODE_ADAPTER_ID);
    expect(adapter.capabilities).toEqual({
      execution: true,
      headless: true,
      modelSelection: true,
      artifactInstallation: true,
      structuredOutput: true,
      usageReporting: true,
      deterministic: false,
    });
  });

  it('refuses unknown options and a budget outside API Key Mode', () => {
    expect(() => new ClaudeCodeAdapter({ bare: true } as ClaudeCodeAdapterOptions)).toThrow(
      /^Invalid claude-code adapter options: /,
    );
    expect(() => new ClaudeCodeAdapter({ maxBudgetUsd: 1 })).toThrow(/API Key Mode/);
    expect(() => new ClaudeCodeAdapter({ authMode: 'api-key', maxBudgetUsd: -1 })).toThrow(
      /maxBudgetUsd/,
    );
    expect(() => new ClaudeCodeAdapter({ permissionProfile: 'bypass' as 'edit-only' })).toThrow(
      /permissionProfile/,
    );
  });
});

posix('ClaudeCodeAdapter with a fake claude', () => {
  it('detects the binary on the given PATH with per-mode readiness', async () => {
    const h = harness();
    const detection = await h.adapter().detect();
    expect(detection).toMatchObject({
      adapterId: 'claude-code',
      installed: true,
      version: '2.1.296 (Claude Code)',
      executablePath: h.fake.executable,
      auth: 'ready',
    });
  });

  it('installs through the §4.1 convention into the pinned workspace', async () => {
    const h = harness();
    const request = await h.request();
    const installed = await h.adapter().installArtifact(request.workspace, SKILL);
    expect(installed.paths).toEqual(['.claude/skills/pdf/SKILL.md']);
  });

  it('runs a subscription skill run: confined argv, no credential variable, parsed outcome (AC-4, FR-118-03/08/09)', async () => {
    const h = harness();
    h.fake.setStream(fixture('skill-invoked'));
    const request = await h.request({
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    });
    const result = await h.adapter().run(request);
    expect(result).toMatchObject({
      status: 'completed',
      error: null,
      summary: 'Claude Code finished after 3 turn(s).',
      warnings: ['ambient-user-config'],
      skillActivation: { loaded: true, invoked: true, invocations: 1, otherSkills: [] },
      metadata: {
        adapterVersion: '2.1.296 (Claude Code)',
        authMode: 'subscription',
        isolationProfile: 'user-profile',
        permissionProfile: 'edit-only',
        requestedModel: 'claude-sonnet-4-5-20250929',
        executionModel: 'claude-sonnet-4-5-20250929',
        auxiliaryModels: ['claude-haiku-4-5-20251001'],
        mismatchedMessageModels: [],
      },
    });
    expect(result.errorCode).toBeUndefined();
    // Subscription: tokens only, the client-side cost estimate is dropped (SPEC-203 §4).
    expect(result.usage).toEqual({
      inputTokens: 1290,
      outputTokens: 352,
      cachedInputTokens: 800,
      cacheCreationInputTokens: 200,
    });
    expect(result.trace.some((event) => event.type === 'tool-call')).toBe(true);
    const env = h.fake.env();
    expect(
      Object.keys(env).filter((name) => /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR)/.test(name)),
    ).toEqual([]);
    expect(env.HOME).toBe(h.home);
    expect(env.TMPDIR).toBe(join(request.scratchDir, 'tmp'));
    expect(h.fake.cwd()).toBe(request.workspace.canonical);
    expect(h.fake.stdin()).toBe('Write output.md');
    const argv = h.fake.argv();
    expect(argv).toContain('Skill(pdf)');
    expect(argv).toContain('Edit(/**)');
    expect(
      argv.slice(argv.indexOf('--setting-sources'), argv.indexOf('--setting-sources') + 2),
    ).toEqual(['--setting-sources', 'project,local']);
    expect(argv.join(' ')).not.toContain('Write output.md');
  });

  it('hashes the argv of two workspaces equally (FR-118-04)', async () => {
    const h = harness();
    h.fake.setStream(fixture('skill-invoked'));
    const adapter = h.adapter();
    const first = await adapter.run(await h.request());
    const second = await adapter.run(await h.request());
    expect(first.metadata?.flagsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.metadata?.flagsHash).toBe(first.metadata?.flagsHash);
  });

  it('runs API Key Mode with a run-local HOME and CLAUDE_CONFIG_DIR, the key only in the environment (AC-4, FR-118-02/03)', async () => {
    const h = harness();
    h.fake.setStream(SECRET_STREAM(fixture('secret-in-output')));
    const request = await h.request();
    const result = await h.adapter({ authMode: 'api-key', maxBudgetUsd: 0.5 }).run(request);
    expect(result).toMatchObject({
      status: 'completed',
      warnings: [],
      metadata: { authMode: 'api-key', isolationProfile: 'isolated' },
    });
    expect(result.usage?.costUsd).toBe(0.0123);
    const env = h.fake.env();
    const isolatedHome = join(request.scratchDir, 'home');
    expect(env.HOME).toBe(isolatedHome);
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(isolatedHome, '.claude'));
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    const argv = h.fake.argv();
    expect(argv).not.toContain('--setting-sources');
    expect(argv.slice(-2)).toEqual(['--max-budget-usd', '0.5']);
    expect(argv.join('\n')).not.toContain(KEY);
    // The stream echoed the key in a tool result and in the answer: nothing kept contains it.
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });

  it('runs an instruction artifact without Skill and without skillActivation (FR-118-08)', async () => {
    const h = harness();
    h.fake.setStream(fixture('skill-not-invoked'));
    const claudeMd = bundle('claude-md', { 'CLAUDE.md': 'Always write a report.\n' });
    const result = await h
      .adapter()
      .run(await h.request({ artifact: claudeMd, baselineArtifact: claudeMd }));
    expect(result.status).toBe('completed');
    expect(result.skillActivation).toBeUndefined();
    expect(h.fake.argv().some((argument) => argument.startsWith('Skill'))).toBe(false);
  });

  it('accepts an A/B baseline that resolves to the same skill name', async () => {
    const h = harness();
    h.fake.setStream(fixture('skill-invoked'));
    const baseline = bundle(
      'skill-md',
      { 'SKILL.md': '---\nname: pdf\ndescription: older\n---\nOld body\n' },
      { versionId: 'ver_0' },
    );
    const result = await h.adapter().run(await h.request({ baselineArtifact: baseline }));
    expect(result.status).toBe('completed');
  });

  it('records a denied outside edit as permission-denied, not as an error (FR-118-07)', async () => {
    const h = harness();
    const lines = fixture('skill-invoked').trimEnd().split('\n');
    const result = lines.pop() as string;
    const denied = result.replace(
      '"permission_denials": []',
      '"permission_denials": [{"tool_name": "Edit", "tool_use_id": "toolu_x", "tool_input": {"file_path": "/etc/outside.txt"}}]',
    );
    h.fake.setStream([...lines, denied].join('\n'));
    const outcome = await h.adapter().run(await h.request());
    expect(outcome.status).toBe('completed');
    expect(outcome.warnings).toEqual(['ambient-user-config', 'permission-denied']);
    expect(outcome.trace).toContainEqual({
      type: 'permission-denied',
      tool: 'Edit',
      callId: 'toolu_x',
    });
  });

  it('maps a stream failure to its §9 code (rate limit)', async () => {
    const h = harness();
    h.fake.setStream(fixture('rate-limited'));
    const result = await h.adapter().run(await h.request());
    expect(result).toMatchObject({ status: 'agent-error', errorCode: 'rate-limited' });
  });

  it('refuses invalid case options before claude starts', async () => {
    const h = harness();
    const result = await h
      .adapter()
      .run(await h.request({ options: { permissionMode: 'bypass' } }));
    expect(result.status).toBe('agent-error');
    expect(result.metadata).toBeUndefined();
    expect(result.error).toMatch(/^Invalid claude-code agent options: /);
    expect(result.errorCode).toBeUndefined();
    expect(h.fake.invoked()).toBe(false);
  });

  it.each([
    [
      'a candidate with frontmatter hooks',
      { artifact: bundle('skill-md', { 'SKILL.md': '---\nname: pdf\nhooks:\n  Stop: []\n---\n' }) },
      'artifact-executes-code',
      /candidate SKILL\.md: /,
    ],
    [
      'a baseline that overrides the model',
      {
        baselineArtifact: bundle(
          'skill-md',
          { 'SKILL.md': '---\nname: pdf\nmodel: opus\n---\n' },
          { versionId: 'ver_0' },
        ),
      },
      'artifact-overrides-model',
      /baseline SKILL\.md: /,
    ],
  ])('refuses %s before claude starts (FR-118-26)', async (_name, overrides, code, detail) => {
    const h = harness();
    const result = await h.adapter().run(await h.request(overrides));
    expect(result).toMatchObject({
      status: 'infrastructure-error',
      errorCode: code,
      warnings: ['ambient-user-config'],
      trace: [],
      usage: null,
    });
    expect(result.error).toMatch(detail);
    expect(result.metadata).toBeUndefined();
    expect(h.fake.invoked()).toBe(false);
  });

  it('refuses a baseline whose skill name differs (FR-118-08)', async () => {
    const h = harness();
    const baseline = bundle(
      'skill-md',
      { 'SKILL.md': '---\nname: other\n---\n' },
      { versionId: 'ver_0' },
    );
    const result = await h.adapter().run(await h.request({ baselineArtifact: baseline }));
    expect(result).toMatchObject({
      status: 'infrastructure-error',
      errorCode: 'baseline-skill-name-differs',
    });
    expect(h.fake.invoked()).toBe(false);
  });

  it.each([
    [
      'an artifact format without install convention',
      { artifact: bundle('cursor-rule', { 'a.mdc': 'x' }) },
      'artifact-format-unsupported',
    ],
    [
      'a model of another provider',
      { model: { provider: 'openai', model: 'gpt-5' } },
      'model-provider-unsupported',
    ],
  ] as const)('refuses %s with its ClaudeCodeError code', async (_name, overrides, code) => {
    const h = harness();
    const result = await h.adapter().run(await h.request(overrides as Partial<AgentRunRequest>));
    expect(result).toMatchObject({ status: 'infrastructure-error', errorCode: code });
    expect(h.fake.invoked()).toBe(false);
  });

  it('refuses API Key Mode without a key (auth-missing, a stop code)', async () => {
    const h = harness();
    const { ANTHROPIC_API_KEY: _key, ...withoutKey } = h.env;
    const result = await h.adapter({ authMode: 'api-key' }, withoutKey).run(await h.request());
    expect(result).toMatchObject({ status: 'infrastructure-error', errorCode: 'auth-missing' });
    expect(h.fake.invoked()).toBe(false);
  });

  it('refuses when claude is not on PATH, or too old', async () => {
    const missing = harness();
    const notFound = await missing
      .adapter({}, { ...missing.env, PATH: '/nonexistent' })
      .run(await missing.request());
    expect(notFound).toMatchObject({
      status: 'infrastructure-error',
      errorCode: 'binary-not-found',
    });

    const old = harness({ version: '2.0.0 (Claude Code)' });
    const tooOld = await old.adapter().run(await old.request());
    expect(tooOld).toMatchObject({
      status: 'infrastructure-error',
      errorCode: 'version-unsupported',
    });
    expect(old.fake.invoked()).toBe(false);
  });

  it('ends a run the pre-spawn inspection refuses before claude starts (FR-118-06)', async () => {
    const h = harness();
    const request = await h.request();
    mkdirSync(join(request.workspace.path, '.claude'));
    writeFileSync(join(request.workspace.path, '.claude/settings.local.json'), '{}');
    const result = await h.adapter().run(request);
    expect(result).toMatchObject({
      status: 'infrastructure-error',
      errorCode: 'workspace-contains-claude-config',
      warnings: ['ambient-user-config'],
    });
    expect(result.metadata).toBeUndefined();
    expect(h.fake.invoked()).toBe(false);
  });

  it('does not start claude after cancellation', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.adapter().run(await h.request({ signal: controller.signal }));
    expect(result).toMatchObject({
      status: 'cancelled',
      summary: 'Cancelled before claude started',
    });
    expect(result.errorCode).toBeUndefined();
    expect(h.fake.invoked()).toBe(false);
  });

  it('keeps what the stream showed when the process layer ends the run (timeout)', async () => {
    const h = harness();
    // The session start, then nothing until the timeout (2 s leave a loaded runner time to write
    // the first line): the parser alone would say
    // output-parse-error, but the timeout decides.
    h.fake.setStream(`${fixture('skill-invoked').split('\n')[0]}\n`, { delaySeconds: 30 });
    const result = await h.adapter().run(await h.request({ timeoutMs: 2_000 }));
    expect(result).toMatchObject({
      status: 'timeout',
      summary: 'claude did not finish in time',
      error: 'claude did not finish in time',
      metadata: { executionModel: 'claude-sonnet-4-5-20250929' },
    });
    expect(result.errorCode).toBeUndefined();
  });

  it('keeps the process layer code when it ends the run (output limit)', async () => {
    const root = tempRoot();
    const fake = writeFakeClaude(root, 'flood');
    const home = join(root, 'home');
    mkdirSync(home);
    const workspaceDir = join(root, 'workspace');
    const scratchDir = join(root, 'scratch');
    mkdirSync(workspaceDir);
    mkdirSync(scratchDir);
    const adapter = new ClaudeCodeAdapter({}, { PATH: `${fake.binDir}:/usr/bin:/bin`, HOME: home });
    const result = await adapter.run({
      workspace: await pinWorkspace(workspaceDir),
      installedPaths: [],
      scratchDir,
      artifact: SKILL,
      baselineArtifact: null,
      prompt: 'p',
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      model: null,
      options: {},
    });
    expect(result).toMatchObject({ status: 'agent-error', errorCode: 'output-limit' });
  });

  it('turns an unexpected error into infrastructure-error without a code', async () => {
    const h = harness();
    const request = await h.request();
    // The scratch directory is a file: creating the run-local temp directory fails.
    const scratch = join(h.root, 'scratch-file');
    writeFileSync(scratch, 'x');
    const result = await h.adapter().run({ ...request, scratchDir: scratch });
    expect(result).toMatchObject({
      status: 'infrastructure-error',
      warnings: ['ambient-user-config'],
    });
    expect(result.error).toMatch(/ENOTDIR|EEXIST/);
    expect(result.errorCode).toBeUndefined();
    expect(h.fake.invoked()).toBe(false);
  });
});
