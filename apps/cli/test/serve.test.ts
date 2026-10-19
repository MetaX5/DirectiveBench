import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireNextJob, enqueueBenchmarkJob } from '@directivebench/database';
import { importBundledExample } from '@directivebench/runner';
import { CliError, ExitCode, resolveAssets, type Assets } from '../src/runtime';
import { initialize } from '../src/setup';
import {
  checkPortFree,
  openBrowser,
  serve,
  type ChildHandle,
  type ServeDeps,
  type ServeFlags,
  type ServeProcess,
} from '../src/serve';

/** A stand-in for the `next start` child process. */
class FakeChild extends EventEmitter implements ChildHandle {
  exitCode: number | null = null;
  stdout: EventEmitter | null = new EventEmitter();
  stderr: EventEmitter | null = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];
  /** When set, SIGTERM is ignored and only SIGKILL stops the process. */
  ignoreSigterm = false;
  readonly unref = vi.fn();

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.ignoreSigterm) return true;
    setImmediate(() => this.exit(signal === 'SIGKILL' ? 137 : 0));
    return true;
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code);
  }
}

class FakeProcess extends EventEmitter implements ServeProcess {
  readonly platform: NodeJS.Platform;
  readonly execPath = '/opt/node/bin/node';
  readonly stdout = { write: vi.fn() };
  readonly stderr = { write: vi.fn() };
  readonly exit = vi.fn();
  /**
   * Resolves once `serve()` registers its SIGINT handler, i.e. it is up and waiting for a signal.
   * `newListener` fires just before the listener is added; the listener is in place by the time
   * an awaiting test resumes.
   */
  readonly running = new Promise<void>((resolve) => {
    const onListener = (event: string | symbol) => {
      if (event !== 'SIGINT') return;
      this.off('newListener', onListener);
      resolve();
    };
    this.on('newListener', onListener);
  });
  constructor(
    readonly env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = 'linux',
  ) {
    super();
    this.platform = platform;
  }
}

const sourceAssets = resolveAssets();
const tempDirs: string[] = [];
const servers: Server[] = [];
const harnesses: Harness[] = [];
let console_: { log: string[]; warn: string[]; error: string[] };

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'db-cli-serve-'));
  tempDirs.push(dir);
  return dir;
}

async function listen(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const port = await listen();
  await new Promise((resolve) => servers.pop()?.close(resolve));
  return port;
}

interface Harness {
  promise: Promise<number>;
  child: FakeChild;
  browser: FakeChild;
  proc: FakeProcess;
  spawn: ReturnType<typeof vi.fn<ServeDeps['spawn']>>;
  fetch: ReturnType<typeof vi.fn<ServeDeps['fetch']>>;
  dataDir: string;
}

function startServe(
  flags: ServeFlags,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    child?: FakeChild;
    deps?: Partial<ServeDeps>;
  } = {},
): Harness {
  const dataDir = flags.dataDir ?? tempDir();
  const child = options.child ?? new FakeChild();
  const browser = new FakeChild();
  const proc = new FakeProcess(options.env ?? { CI: '1' }, options.platform);
  const spawn = vi.fn<ServeDeps['spawn']>((command) =>
    command === proc.execPath ? child : browser,
  );
  const fetch = vi.fn<ServeDeps['fetch']>(() => Promise.resolve({ ok: true }));
  const promise = serve(
    { ...flags, dataDir },
    {
      process: proc,
      spawn,
      fetch,
      healthPollIntervalMs: 1,
      killGraceMs: 20,
      ...options.deps,
    },
  );
  const harness = { promise, child, browser, proc, spawn, fetch, dataDir };
  harnesses.push(harness);
  return harness;
}

/** Waits for the readiness signal instead of polling, so a slow startup cannot time out early. */
async function whenRunning(harness: Harness): Promise<void> {
  await harness.proc.running;
  expect(harness.proc.listenerCount('SIGINT')).toBe(1);
}

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

beforeEach(() => {
  console_ = { log: [], warn: [], error: [] };
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      console_[level].push(args.map(String).join(' '));
    });
  }
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  // web.log is opened asynchronously right before the web server is spawned; wait for it so the
  // temp directory is not removed while the stream is still opening.
  for (const harness of harnesses.splice(0)) {
    if (harness.spawn.mock.calls.length === 0) continue;
    await vi.waitFor(() => expect(existsSync(join(harness.dataDir, 'logs', 'web.log'))).toBe(true));
  }
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('checkPortFree', () => {
  it('detects whether a port can be bound', async () => {
    const port = await listen();
    expect(await checkPortFree('127.0.0.1', port)).toBe(false);
    expect(await checkPortFree('127.0.0.1', await freePort())).toBe(true);
  });
});

describe('serve', () => {
  it('starts next start, waits for health, opens the browser and shuts down on SIGINT', async () => {
    const port = await freePort();
    const harness = startServe(
      { port: String(port) },
      { env: { DISPLAY: ':0', HOME: '/home/test' } },
    );
    // Not reachable, then not healthy, then healthy.
    harness.fetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: false });
    await whenRunning(harness);
    const url = `http://127.0.0.1:${port}`;

    expect(harness.spawn).toHaveBeenCalledWith(
      '/opt/node/bin/node',
      [sourceAssets.nextBin, 'start', sourceAssets.webDir, '-H', '127.0.0.1', '-p', String(port)],
      {
        cwd: sourceAssets.webDir,
        env: {
          DISPLAY: ':0',
          HOME: '/home/test',
          NODE_ENV: 'production',
          NEXT_TELEMETRY_DISABLED: '1',
          DIRECTIVEBENCH_DATA_DIR: harness.dataDir,
          DIRECTIVEBENCH_ALLOWED_HOSTS: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(harness.fetch).toHaveBeenCalledTimes(3);
    expect(harness.fetch).toHaveBeenCalledWith(`${url}/api/health`, {
      signal: expect.any(AbortSignal),
    });
    expect(harness.spawn).toHaveBeenCalledWith('xdg-open', [url], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    expect(harness.browser.unref).toHaveBeenCalled();
    expect(console_.log).toContain(`\nDirectiveBench is running at ${url}`);
    expect(console_.warn).toEqual([]);

    harness.child.stdout?.emit('data', Buffer.from('next ready\n'));
    harness.child.stderr?.emit('data', Buffer.from('next warning\n'));
    expect(harness.proc.stdout.write).not.toHaveBeenCalled();
    expect(harness.proc.stderr.write).toHaveBeenCalledWith(Buffer.from('next warning\n'));

    harness.proc.emit('SIGINT');
    expect(await harness.promise).toBe(ExitCode.Ok);
    expect(harness.child.signals).toEqual(['SIGTERM']);
    expect(harness.proc.exit).not.toHaveBeenCalled();
    expect(console_.error).toEqual([]);
    await vi.waitFor(() =>
      expect(readFileSync(join(harness.dataDir, 'logs', 'web.log'), 'utf8')).toBe(
        'next ready\nnext warning\n',
      ),
    );
  });

  it('runs next dev with echoed output and reports an unexpected exit of the web server', async () => {
    const harness = startServe({ port: String(await freePort()), dev: true, open: false });
    await whenRunning(harness);

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    const [, args, options] = harness.spawn.mock.calls[0] ?? [];
    expect(args?.[1]).toBe('dev');
    expect(options?.env?.NODE_ENV).toBe('development');
    harness.child.stdout?.emit('data', Buffer.from('compiled\n'));
    expect(harness.proc.stdout.write).toHaveBeenCalledWith(Buffer.from('compiled\n'));

    harness.child.exit(1);
    expect(await harness.promise).toBe(ExitCode.Runtime);
    expect(console_.error).toContain('The web server exited unexpectedly (code 1).');
    expect(harness.child.signals).toEqual([]);
  });

  it('refuses --dev outside the source repository before touching the data directory', async () => {
    const packaged: Assets = { ...sourceAssets, mode: 'packaged' };
    const dataDir = join(tempDir(), 'data');
    const harness = startServe({ dev: true, dataDir }, { deps: { resolveAssets: () => packaged } });
    const error = await rejection(harness.promise);
    expect(error.message).toBe('--dev is only available when running from the source repository');
    expect(error.exitCode).toBe(ExitCode.Usage);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('fails with a dedicated exit code when the port is taken', async () => {
    const port = await listen();
    const harness = startServe({ port: String(port) });
    const error = await rejection(harness.promise);
    expect(error.message).toBe(
      `Port ${port} on 127.0.0.1 is already in use. Choose another one with --port <port>.`,
    );
    expect(error.exitCode).toBe(ExitCode.PortInUse);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it('fails when the web server exits during startup', async () => {
    const child = new FakeChild();
    child.exitCode = 1;
    const harness = startServe({ port: String(await freePort()) }, { child });
    const error = await rejection(harness.promise);
    expect(error.message).toBe('The web server exited during startup (see logs)');
    expect(error.exitCode).toBe(ExitCode.Runtime);
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(child.signals).toEqual([]);
  });

  it('times out when the web server never becomes healthy and kills it forcefully', async () => {
    const child = new FakeChild();
    child.ignoreSigterm = true;
    const harness = startServe(
      { port: String(await freePort()) },
      { child, deps: { readyTimeoutMs: 30 } },
    );
    harness.fetch.mockResolvedValue({ ok: false });
    const error = await rejection(harness.promise);
    expect(error.message).toBe('The web server did not become ready within 0.03s');
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.exitCode).toBe(137);
  });

  it('allows an explicit non-loopback host, warns, and force-exits on a second signal', async () => {
    const harness = startServe(
      { host: '192.0.2.10', port: '4999', allowNetworkAccess: true },
      { env: { DISPLAY: ':0', CI: 'true' }, deps: { checkPortFree: () => Promise.resolve(true) } },
    );
    await whenRunning(harness);

    expect(harness.spawn).toHaveBeenCalledTimes(1);
    expect(harness.spawn.mock.calls[0]?.[2].env?.DIRECTIVEBENCH_ALLOWED_HOSTS).toBe('192.0.2.10');
    expect(console_.log).toContain('\nDirectiveBench is running at http://192.0.2.10:4999');
    expect(console_.warn).toEqual([
      '  WARNING: listening on a non-loopback address. This instance has no authentication.',
    ]);

    harness.proc.emit('SIGTERM');
    harness.proc.emit('SIGTERM');
    expect(harness.proc.exit).toHaveBeenCalledWith(ExitCode.Runtime);
    expect(await harness.promise).toBe(ExitCode.Ok);
  });

  it.each([
    ['0.0.0.0', 'http://0.0.0.0:4999', true],
    ['::', 'http://[::]:4999', true],
    ['::1', 'http://[::1]:4999', false],
  ])('binds %s with an empty Host allowlist (%s)', async (host, url, warns) => {
    const harness = startServe(
      { host, port: '4999', allowNetworkAccess: true, open: false },
      { deps: { checkPortFree: () => Promise.resolve(true) } },
    );
    await whenRunning(harness);
    expect(harness.spawn.mock.calls[0]?.[2].env?.DIRECTIVEBENCH_ALLOWED_HOSTS).toBe('');
    expect(console_.log).toContain(`\nDirectiveBench is running at ${url}`);
    expect(console_.warn.length > 0).toBe(warns);
    harness.proc.emit('SIGINT');
    expect(await harness.promise).toBe(ExitCode.Ok);
  });

  it.each<[string, NodeJS.Platform, NodeJS.ProcessEnv, string | null]>([
    ['Wayland', 'linux', { WAYLAND_DISPLAY: 'wayland-0' }, 'xdg-open'],
    ['no display server', 'linux', {}, null],
    ['macOS', 'darwin', {}, 'open'],
  ])('decides whether to open a browser: %s', async (_name, platform, env, opener) => {
    const harness = startServe({ port: String(await freePort()) }, { env, platform });
    await whenRunning(harness);
    const commands = harness.spawn.mock.calls.map(([command]) => command);
    expect(commands.slice(1)).toEqual(opener ? [opener] : []);
    harness.proc.emit('SIGINT');
    await harness.promise;
  });

  it('records crash recovery of orphaned jobs in runner.log with the runner id', async () => {
    const dataDir = tempDir();
    const { layout, handle } = await initialize(dataDir, sourceAssets.migrationsDir);
    const example = await importBundledExample(handle, sourceAssets.examplesDir, layout.fixtures);
    await enqueueBenchmarkJob(handle.db, {
      suiteVersionId: example.suite.versionId,
      artifactVersionId: example.artifact.versionId,
    });
    const job = await acquireNextJob(handle.db, 'crashed-runner');
    // Simulate a runner that died long ago: its last heartbeat is far in the past.
    handle.sqlite
      .prepare('update jobs set heartbeat_at = ? where id = ?')
      .run('2000-01-01T00:00:00.000Z', job?.id ?? '');
    handle.close();

    const harness = startServe({ dataDir, port: String(await freePort()) });
    await whenRunning(harness);
    harness.proc.emit('SIGINT');
    await harness.promise;

    const entries = readFileSync(join(dataDir, 'logs', 'runner.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries[0]).toMatchObject({
      level: 'info',
      msg: 'Marked 1 orphaned job(s) as interrupted',
      runnerId: expect.stringMatching(/^local-/),
      jobIds: job?.id,
    });
  });

  it('respects openBrowser: false in config.json and tolerates a child without pipes', async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ server: { openBrowser: false } }));
    const child = new FakeChild();
    child.stdout = null;
    child.stderr = null;
    const harness = startServe(
      { dataDir, port: String(await freePort()) },
      { child, env: { DISPLAY: ':0' } },
    );
    await whenRunning(harness);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    harness.proc.emit('SIGINT');
    expect(await harness.promise).toBe(ExitCode.Ok);
  });

  it('waits for a startup slower than the default vi.waitFor timeout (#38)', async () => {
    // Longer than vi.waitFor's 1000 ms default, which the old polling helper relied on.
    const SLOW_STARTUP_MS = 1_200;
    const harness = startServe(
      { port: String(await freePort()), open: false },
      {
        deps: {
          checkPortFree: (host, port) =>
            new Promise((resolve) => setTimeout(resolve, SLOW_STARTUP_MS)).then(() =>
              checkPortFree(host, port),
            ),
        },
      },
    );
    await whenRunning(harness);
    harness.proc.emit('SIGINT');
    expect(await harness.promise).toBe(ExitCode.Ok);
  });
});

describe('openBrowser', () => {
  const url = 'http://127.0.0.1:4280';

  it('uses start through cmd on Windows', () => {
    const child = new FakeChild();
    const spawn = vi.fn<ServeDeps['spawn']>(() => child);
    openBrowser(url, { spawn, platform: 'win32' });
    expect(spawn).toHaveBeenCalledWith('cmd', ['/c', 'start', '""', url], expect.any(Object));
    expect(child.unref).toHaveBeenCalled();
  });

  it('warns instead of failing when the opener cannot be spawned', () => {
    openBrowser(url, {
      spawn: () => {
        throw new Error('EACCES');
      },
      platform: 'linux',
    });
    expect(console_.warn).toEqual([`Could not open a browser. Visit ${url}`]);
  });

  it('warns when the opener reports an error asynchronously', () => {
    const child = new FakeChild();
    openBrowser(url, { spawn: () => child, platform: 'linux' });
    expect(console_.warn).toEqual([]);
    child.emit('error', new Error('ENOENT'));
    expect(console_.warn).toEqual([`Could not open a browser. Visit ${url}`]);
  });
});
