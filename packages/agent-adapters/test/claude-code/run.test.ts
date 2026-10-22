import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildClaudeArgv,
  buildClaudeEnv,
  claudeProcessEnd,
  installClaudeArtifact,
  REFUSAL_FINDINGS_SHOWN,
  runClaudeCode,
  type ClaudeProcessResult,
  type ClaudeRunInput,
} from '../../src/claude-code';
import { pinWorkspace } from '../../src/workspace-pin';
import { writeFakeClaude, type FakeClaudeMode } from './fake-claude';
import { bundle } from './helpers';

const posix = describe.skipIf(process.platform === 'win32');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function setup(mode: FakeClaudeMode = 'stream') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-run-')));
  roots.push(root);
  const fake = writeFakeClaude(root, mode);
  const workspaceDir = join(root, 'workspace');
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  for (const dir of [workspaceDir, home, temp]) mkdirSync(dir);
  writeFileSync(join(workspaceDir, 'CLAUDE.md'), 'Plain project instructions.\n');
  const workspace = await pinWorkspace(workspaceDir);
  const env = buildClaudeEnv({
    authMode: 'subscription',
    baseEnv: { PATH: `${fake.binDir}:/usr/bin:/bin`, HOME: home },
    tempDir: temp,
  });
  const input = (overrides: Partial<ClaudeRunInput> = {}): ClaudeRunInput => ({
    executable: fake.executable,
    argv: buildClaudeArgv({
      authMode: 'subscription',
      permissionProfile: 'edit-only',
      artifact: { format: 'skill-md', skillName: 'pdf' },
      model: null,
    }),
    env,
    workspace,
    installedPaths: [],
    prompt: 'task',
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    ...overrides,
  });
  return { root, fake, workspace, workspaceDir, home, input };
}

posix('runClaudeCode: pre-spawn inspection, then the process', () => {
  it('runs claude in the canonical workspace and leaves parsing to the stream parser', async () => {
    const { fake, workspace, input } = await setup();
    const outcome = await runClaudeCode(input());
    expect(outcome.ended).toBeNull();
    expect(outcome.findings).toEqual([]);
    expect(outcome.process?.lines).toHaveLength(3);
    expect(fake.cwd()).toBe(workspace.canonical);
    expect(fake.stdin()).toBe('task');
  });

  it('refuses configuration a setup command wrote, before claude starts (FR-118-06/15)', async () => {
    const { fake, workspaceDir, input } = await setup();
    mkdirSync(join(workspaceDir, '.claude'));
    writeFileSync(
      join(workspaceDir, '.claude/settings.local.json'),
      '{"permissions":{"allow":["Skill"]}}',
    );
    const outcome = await runClaudeCode(input());
    expect(outcome.ended).toMatchObject({
      status: 'infrastructure-error',
      errorCode: 'workspace-contains-claude-config',
    });
    expect(outcome.ended?.message).toMatch(/^The workspace was refused before claude started: /);
    expect(outcome.ended?.message).toContain('.claude');
    expect(outcome.process).toBeNull();
    expect(fake.invoked()).toBe(false);
  });

  it('exempts only the installed artifact from the configuration check', async () => {
    const { fake, workspace, input } = await setup();
    const installed = await installClaudeArtifact(
      workspace,
      bundle('skill-md', { 'SKILL.md': '---\nname: pdf\ndescription: d\n---\nBody\n' }),
    );
    const outcome = await runClaudeCode(input({ installedPaths: installed.paths }));
    expect(outcome.ended).toBeNull();
    expect(fake.invoked()).toBe(true);
  });

  it('refuses an import of a host file with file, token and target (FR-118-27)', async () => {
    const { root, fake, workspaceDir, input } = await setup();
    const hostFile = join(root, 'host-secret.txt');
    writeFileSync(hostFile, 'secret');
    writeFileSync(join(workspaceDir, 'CLAUDE.md'), `See @${hostFile}\n`);
    const outcome = await runClaudeCode(input());
    expect(outcome.ended).toMatchObject({
      status: 'infrastructure-error',
      errorCode: 'workspace-imports-outside',
    });
    expect(outcome.ended?.message).toContain(`CLAUDE.md: `);
    expect(outcome.ended?.message).toContain(`(${hostFile} → ${hostFile})`);
    expect(fake.invoked()).toBe(false);
  });

  it('resolves `~` against the agent HOME', async () => {
    const { fake, home, workspaceDir, input } = await setup();
    writeFileSync(join(home, 'planted.md'), 'host');
    writeFileSync(join(workspaceDir, 'CLAUDE.md'), '@~/planted.md\n');
    const outcome = await runClaudeCode(input());
    expect(outcome.ended?.errorCode).toBe('workspace-imports-outside');
    expect(fake.invoked()).toBe(false);
  });

  it('names the first findings and counts the rest', async () => {
    const { root, workspaceDir, input } = await setup();
    const count = REFUSAL_FINDINGS_SHOWN + 3;
    for (let index = 0; index < count; index += 1) {
      symlinkSync(root, join(workspaceDir, `link-${index}`));
    }
    const outcome = await runClaudeCode(input());
    expect(outcome.findings).toHaveLength(count);
    expect(outcome.ended?.message).toMatch(/ and 3 more$/);
  });

  it('refuses a workspace a setup command replaced (workspace-replaced)', async () => {
    const { root, fake, workspaceDir, input } = await setup();
    renameSync(workspaceDir, join(root, 'moved'));
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), workspaceDir);
    const outcome = await runClaudeCode(input());
    expect(outcome.ended).toMatchObject({
      status: 'infrastructure-error',
      errorCode: 'workspace-replaced',
    });
    expect(fake.invoked()).toBe(false);
  });

  it('starts nothing after a cancellation or timeout, also one during the inspection', async () => {
    const { fake, input } = await setup();
    expect((await runClaudeCode(input({ signal: AbortSignal.abort() }))).ended).toEqual({
      status: 'cancelled',
      errorCode: null,
      message: 'Cancelled before claude started',
    });
    const timedOut = new AbortController();
    timedOut.abort(new DOMException('timed out', 'TimeoutError'));
    expect((await runClaudeCode(input({ signal: timedOut.signal }))).ended?.status).toBe('timeout');
    // Aborted once the inspection has started (the function runs synchronously up to it).
    const during = new AbortController();
    const pending = runClaudeCode(input({ signal: during.signal }));
    during.abort();
    expect((await pending).ended?.status).toBe('cancelled');
    expect(fake.invoked()).toBe(false);
  });

  it('passes a kill grace through to the process', async () => {
    const { fake, input } = await setup('hang');
    const outcome = await runClaudeCode(input({ timeoutMs: 100, killGraceMs: 100 }));
    expect(outcome.ended?.status).toBe('timeout');
    expect(outcome.process?.signal).toBe('SIGKILL');
    try {
      process.kill(fake.childPid() as number, 'SIGKILL');
    } catch {
      // Killed with the group, as expected.
    }
  });

  it('requires HOME in the environment', async () => {
    const { input } = await setup();
    await expect(runClaudeCode(input({ env: { PATH: '/bin' } }))).rejects.toThrow(/must set HOME/);
  });
});

describe('claudeProcessEnd', () => {
  const base: ClaudeProcessResult = {
    spawned: true,
    lines: [],
    stderr: '',
    stderrTruncated: false,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    strayProcesses: false,
    error: null,
    stdinError: null,
    durationMs: 1,
  };

  it('maps each process-level end, in order of precedence', () => {
    expect(claudeProcessEnd(base)).toBeNull();
    expect(claudeProcessEnd({ ...base, cancelled: true, timedOut: true })?.status).toBe(
      'cancelled',
    );
    expect(claudeProcessEnd({ ...base, timedOut: true, outputLimitExceeded: true })?.status).toBe(
      'timeout',
    );
    expect(claudeProcessEnd({ ...base, spawned: false, error: 'spawn x ENOENT' })).toEqual({
      status: 'infrastructure-error',
      errorCode: 'spawn-failed',
      message: 'claude could not be started: spawn x ENOENT',
    });
    expect(
      claudeProcessEnd({ ...base, strayProcesses: true, outputLimitExceeded: true })?.errorCode,
    ).toBe('stray-processes');
    expect(claudeProcessEnd({ ...base, outputLimitExceeded: true })).toMatchObject({
      status: 'agent-error',
      errorCode: 'output-limit',
    });
  });
});
