import { spawn, type SpawnOptions } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createExecutableAdapters } from '@directivebench/agent-adapters';
import { isLoopbackHost } from '@directivebench/core';
import { LocalRunner } from '@directivebench/runner';
import { createRunnerLogger } from './logger';
import { CliError, ExitCode, resolveAssets, type Assets } from './runtime';
import { initialize, resolveServerOptions } from './setup';

export interface ServeFlags {
  host?: string;
  port?: string;
  dataDir?: string;
  open?: boolean;
  allowNetworkAccess?: boolean;
  dev?: boolean;
}

const READY_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 300;
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const KILL_GRACE_MS = 5_000;

/** The parts of a spawned child process `serve` and `openBrowser` use. */
export interface ChildHandle {
  readonly exitCode: number | null;
  readonly stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  readonly stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  unref(): void;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildHandle;

/** The parts of the current process `serve` uses (environment, signals, output, exit). */
export interface ServeProcess {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly stdout: { write(chunk: Buffer): unknown };
  readonly stderr: { write(chunk: Buffer): unknown };
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): void;
}

/** External effects of `serve`, injectable so its supervision logic can be tested. */
export interface ServeDeps {
  resolveAssets: () => Assets;
  checkPortFree: (host: string, port: number) => Promise<boolean>;
  spawn: SpawnFn;
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>;
  process: ServeProcess;
  readyTimeoutMs: number;
  healthPollIntervalMs: number;
  killGraceMs: number;
}

export function checkPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function waitForHealth(url: string, child: ChildHandle, deps: ServeDeps): Promise<void> {
  const deadline = Date.now() + deps.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new CliError('The web server exited during startup (see logs)', ExitCode.Runtime);
    try {
      const response = await deps.fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, deps.healthPollIntervalMs));
  }
  throw new CliError(
    `The web server did not become ready within ${deps.readyTimeoutMs / 1000}s`,
    ExitCode.Runtime,
  );
}

function hasDisplay({ env, platform }: Pick<ServeProcess, 'env' | 'platform'>): boolean {
  if (env.CI) return false;
  if (platform === 'linux') return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  return true;
}

/** Opens the URL with the platform opener; failures are warnings, never errors. */
export function openBrowser(
  url: string,
  deps: { spawn: SpawnFn; platform: NodeJS.Platform } = {
    spawn,
    platform: process.platform,
  },
): void {
  const [command, args] =
    deps.platform === 'darwin'
      ? ['open', [url]]
      : deps.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = deps.spawn(command, args as string[], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => console.warn(`Could not open a browser. Visit ${url}`));
    child.unref();
  } catch {
    console.warn(`Could not open a browser. Visit ${url}`);
  }
}

const defaultServeDeps: ServeDeps = {
  resolveAssets,
  checkPortFree,
  spawn,
  fetch,
  process,
  readyTimeoutMs: READY_TIMEOUT_MS,
  healthPollIntervalMs: HEALTH_POLL_INTERVAL_MS,
  killGraceMs: KILL_GRACE_MS,
};

export async function serve(
  flags: ServeFlags,
  overrides: Partial<ServeDeps> = {},
): Promise<number> {
  const deps: ServeDeps = { ...defaultServeDeps, ...overrides };
  const assets = deps.resolveAssets();
  if (flags.dev && assets.mode !== 'source') {
    throw new CliError(
      '--dev is only available when running from the source repository',
      ExitCode.Usage,
    );
  }
  const workspace = await initialize(flags.dataDir, assets.migrationsDir);
  const { layout, config, handle } = workspace;
  const { host, port } = resolveServerOptions(flags, config, deps.process.env);

  if (!(await deps.checkPortFree(host, port))) {
    handle.close();
    throw new CliError(
      `Port ${port} on ${host} is already in use. Choose another one with --port <port>.`,
      ExitCode.PortInUse,
    );
  }

  const runner: LocalRunner = new LocalRunner({
    handle,
    fixtureStore: layout.fixtures,
    cacheDir: layout.cache,
    adapters: createExecutableAdapters(),
    concurrency: config.runner.concurrency,
    keepWorkspaces: config.runner.keepWorkspaces,
    logger: createRunnerLogger(join(layout.logs, 'runner.log'), (): string => runner.runnerId),
  });
  await runner.start();

  const urlHost = host.includes(':') ? `[${host}]` : host;
  const url = `http://${urlHost}:${port}`;
  const log = createWriteStream(join(layout.logs, 'web.log'), { flags: 'a' });
  const allowedHosts = isLoopbackHost(host) || host === '0.0.0.0' || host === '::' ? '' : host;
  const child = deps.spawn(
    deps.process.execPath,
    [assets.nextBin, flags.dev ? 'dev' : 'start', assets.webDir, '-H', host, '-p', String(port)],
    {
      cwd: assets.webDir,
      env: {
        ...deps.process.env,
        NODE_ENV: flags.dev ? 'development' : 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        DIRECTIVEBENCH_DATA_DIR: layout.root,
        DIRECTIVEBENCH_ALLOWED_HOSTS: allowedHosts,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    log.write(chunk);
    if (flags.dev) deps.process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log.write(chunk);
    deps.process.stderr.write(chunk);
  });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<number> => {
    if (shuttingDown) return code;
    shuttingDown = true;
    console.log('\nShutting down…');
    await runner.stop();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), deps.killGraceMs);
      await new Promise((r) => child.once('exit', r));
      clearTimeout(killTimer);
    }
    log.end();
    handle.close();
    return code;
  };

  try {
    await waitForHealth(url, child, deps);
  } catch (error) {
    await shutdown(ExitCode.Runtime);
    throw error;
  }

  console.log(`\nDirectiveBench is running at ${url}`);
  console.log(`  data directory: ${layout.root}`);
  console.log(`  logs:           ${layout.logs} (web.log, runner.log)`);
  if (!isLoopbackHost(host)) {
    console.warn(
      '  WARNING: listening on a non-loopback address. This instance has no authentication.',
    );
  }
  console.log('Press Ctrl+C to stop.\n');
  if (flags.open !== false && config.server.openBrowser && hasDisplay(deps.process))
    openBrowser(url, { spawn: deps.spawn, platform: deps.process.platform });

  return new Promise<number>((resolve) => {
    let signals = 0;
    const onSignal = () => {
      signals += 1;
      if (signals > 1) deps.process.exit(ExitCode.Runtime);
      void shutdown(ExitCode.Ok).then(resolve);
    };
    deps.process.on('SIGINT', onSignal);
    deps.process.on('SIGTERM', onSignal);
    child.once('exit', (code) => {
      if (shuttingDown) return;
      console.error(`The web server exited unexpectedly (code ${code}).`);
      void shutdown(ExitCode.Runtime).then(resolve);
    });
  });
}
