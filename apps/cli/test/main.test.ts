import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { ExitCode } from '../src/runtime';
import { fakeNodeVersion } from './support/node-version';

// main.ts parses process.argv when it is imported; the command implementations are replaced so
// only argument handling, exit codes and error reporting are exercised here.
const commands = vi.hoisted(() => ({
  initCommand: vi.fn(),
  doctorCommand: vi.fn(),
  demoCommand: vi.fn(),
  serve: vi.fn(),
  benchmarkInitCommand: vi.fn(),
  benchmarkRunCommand: vi.fn(),
  benchmarkExportCommand: vi.fn(),
}));
vi.mock('../src/benchmark-init', () => ({ benchmarkInitCommand: commands.benchmarkInitCommand }));
vi.mock('../src/benchmark-export', () => ({
  benchmarkExportCommand: commands.benchmarkExportCommand,
}));
vi.mock('../src/benchmark-run', () => ({ benchmarkRunCommand: commands.benchmarkRunCommand }));
vi.mock('../src/commands', () => ({
  initCommand: commands.initCommand,
  doctorCommand: commands.doctorCommand,
  demoCommand: commands.demoCommand,
}));
vi.mock('../src/serve', () => ({ serve: commands.serve }));

const originalArgv = process.argv;
let stdout: string[];
let stderr: string[];
let errors: string[];

async function runCli(...args: string[]): Promise<typeof process.exitCode> {
  process.argv = ['node', 'directivebench', ...args];
  vi.resetModules();
  await import('../src/main');
  return process.exitCode;
}

beforeEach(() => {
  stdout = [];
  stderr = [];
  errors = [];
  for (const fn of Object.values(commands)) fn.mockReset().mockResolvedValue(ExitCode.Ok);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  process.exitCode = undefined;
});

const defaults = {
  host: undefined,
  port: undefined,
  open: true,
  allowNetworkAccess: false,
  dev: false,
  dataDir: undefined,
};

describe('directivebench (main)', () => {
  it('serves with defaults when no command is given', async () => {
    expect(await runCli()).toBe(ExitCode.Ok);
    expect(commands.serve).toHaveBeenCalledWith(defaults);
  });

  it('accepts serve options without the serve subcommand', async () => {
    await runCli(
      '--data-dir',
      '/data',
      '--host',
      '0.0.0.0',
      '--port',
      '5000',
      '--no-open',
      '--allow-network-access',
    );
    expect(commands.serve).toHaveBeenCalledWith({
      host: '0.0.0.0',
      port: '5000',
      open: false,
      allowNetworkAccess: true,
      dev: false,
      dataDir: '/data',
    });
  });

  it('prefers options given after the serve subcommand over global ones', async () => {
    await runCli('--port', '5000', '--host', 'localhost', 'serve', '--port', '6000', '--dev');
    expect(commands.serve).toHaveBeenCalledWith({
      ...defaults,
      host: 'localhost',
      port: '6000',
      dev: true,
    });
  });

  it.each([
    [['--no-open', 'serve'], false],
    [['serve', '--no-open'], false],
    [['serve'], true],
  ])('combines --no-open from both positions: %j', async (args, open) => {
    await runCli(...args);
    expect(commands.serve).toHaveBeenCalledWith({ ...defaults, open });
  });

  it('passes the global data directory to init, doctor and demo', async () => {
    await runCli('--data-dir', '/d', 'init');
    expect(commands.initCommand).toHaveBeenCalledWith({ dataDir: '/d' });
    await runCli('doctor', '--json');
    expect(commands.doctorCommand).toHaveBeenCalledWith({ json: true, dataDir: undefined });
    await runCli('--data-dir', '/d', 'demo');
    expect(commands.demoCommand).toHaveBeenCalledWith({ dataDir: '/d' });
  });

  it('passes benchmark init and run options, with --artifact-version as version', async () => {
    await runCli('--data-dir', '/d', 'benchmark', 'init', '--artifact', 'pdf');
    expect(commands.benchmarkInitCommand).toHaveBeenCalledWith({ artifact: 'pdf', dataDir: '/d' });
    await runCli(
      'benchmark',
      'run',
      './suite',
      '--artifact',
      'pdf',
      '--artifact-version',
      '3',
      '--baseline',
      'v2',
      '--auth',
      'api-key',
      '--max-budget-usd',
      '1',
      '--approve-commands',
      '--yes',
      '--json',
    );
    expect(commands.benchmarkRunCommand).toHaveBeenCalledWith({
      suite: './suite',
      artifact: 'pdf',
      version: '3',
      baseline: 'v2',
      auth: 'api-key',
      maxBudgetUsd: '1',
      approveCommands: true,
      yes: true,
      json: true,
      dataDir: undefined,
    });
    await runCli('benchmark', 'run', './suite', '--artifact', 'pdf');
    expect(commands.benchmarkRunCommand).toHaveBeenLastCalledWith({
      suite: './suite',
      artifact: 'pdf',
      dataDir: undefined,
    });
    expect(await runCli('benchmark', 'run', './suite')).toBe(ExitCode.Usage);
    expect(stderr.join('')).toContain("required option '--artifact <ref>' not specified");
  });

  it('passes benchmark export options and requires --out (SPEC-123 FR-123-40)', async () => {
    await runCli('--data-dir', '/d', 'benchmark', 'export', 'brun_1', '--out', './x', '--json');
    expect(commands.benchmarkExportCommand).toHaveBeenCalledWith({
      runId: 'brun_1',
      out: './x',
      json: true,
      dataDir: '/d',
    });
    expect(await runCli('benchmark', 'export', 'brun_1')).toBe(ExitCode.Usage);
    expect(stderr.join('')).toContain("required option '--out <dir>' not specified");
  });

  it("uses the command's result as the exit code", async () => {
    commands.doctorCommand.mockResolvedValue(ExitCode.CheckFailed);
    expect(await runCli('doctor')).toBe(ExitCode.CheckFailed);
  });

  it('prints the version and help with exit code 0', async () => {
    expect(await runCli('--version')).toBe(ExitCode.Ok);
    expect(stdout.join('')).toBe(`${packageJson.version}\n`);
    expect(await runCli('--help')).toBe(ExitCode.Ok);
    expect(stdout.join('')).toContain('Usage: directivebench');
  });

  it('maps usage errors to exit code 2 and shows help', async () => {
    expect(await runCli('--bogus')).toBe(ExitCode.Usage);
    expect(stderr.join('')).toContain("unknown option '--bogus'");
    expect(commands.serve).not.toHaveBeenCalled();
  });

  it('reports CLI errors with their message and exit code', async () => {
    // Modules are re-imported for every run, so the error must come from the same instance of
    // runtime.ts that main.ts uses.
    commands.initCommand.mockImplementation(async () => {
      const runtime = await import('../src/runtime');
      throw new runtime.CliError('Data directory /x is not writable', runtime.ExitCode.DataDir);
    });
    expect(await runCli('init')).toBe(ExitCode.DataDir);
    expect(errors).toEqual(['Error: Data directory /x is not writable']);
  });

  it('refuses to run any command on an unsupported Node.js', async () => {
    const restore = fakeNodeVersion('20.0.0');
    try {
      expect(await runCli('demo')).toBe(ExitCode.UnsupportedRuntime);
    } finally {
      restore();
    }
    expect(commands.demoCommand).not.toHaveBeenCalled();
    expect(errors).toEqual(['Error: Unsupported runtime: Node.js 20.0.0 (requires >= 22.16.0)']);
  });

  it('reports unexpected errors with their stack trace and exit code 1', async () => {
    const error = new Error('database is locked');
    commands.demoCommand.mockRejectedValue(error);
    expect(await runCli('demo')).toBe(ExitCode.Runtime);
    expect(errors).toEqual([error.stack]);
  });

  it('falls back to the message for errors without a stack and to String() otherwise', async () => {
    const error = new Error('no stack');
    delete error.stack;
    commands.demoCommand.mockRejectedValue(error);
    expect(await runCli('demo')).toBe(ExitCode.Runtime);
    commands.demoCommand.mockRejectedValue('plain failure');
    expect(await runCli('demo')).toBe(ExitCode.Runtime);
    expect(errors).toEqual(['no stack', 'plain failure']);
  });
});
