import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createExecutableAdapters } from '@directivebench/agent-adapters';
import { isLoopbackHost } from '@directivebench/core';
import { LocalRunner } from '@directivebench/runner';
import { createRunnerLogger } from './logger';
import { CliError, ExitCode, resolveAssets } from './runtime';
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
const KILL_GRACE_MS = 5_000;

export function checkPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new CliError('The web server exited during startup (see logs)', ExitCode.Runtime);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new CliError(
    `The web server did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
    ExitCode.Runtime,
  );
}

function hasDisplay(): boolean {
  if (process.env.CI) return false;
  if (process.platform === 'linux')
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  return true;
}

/** Opens the URL with the platform opener; failures are warnings, never errors. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args as string[], {
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

export async function serve(flags: ServeFlags): Promise<number> {
  const assets = resolveAssets();
  if (flags.dev && assets.mode !== 'source') {
    throw new CliError(
      '--dev is only available when running from the source repository',
      ExitCode.Usage,
    );
  }
  const workspace = await initialize(flags.dataDir, assets.migrationsDir);
  const { layout, config, handle } = workspace;
  const { host, port } = resolveServerOptions(flags, config);

  if (!(await checkPortFree(host, port))) {
    handle.close();
    throw new CliError(
      `Port ${port} on ${host} is already in use. Choose another one with --port <port>.`,
      ExitCode.PortInUse,
    );
  }

  const runner: LocalRunner = new LocalRunner({
    handle,
    fixtureStore: layout.fixtures,
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
  const child = spawn(
    process.execPath,
    [assets.nextBin, flags.dev ? 'dev' : 'start', assets.webDir, '-H', host, '-p', String(port)],
    {
      cwd: assets.webDir,
      env: {
        ...process.env,
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
    if (flags.dev) process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log.write(chunk);
    process.stderr.write(chunk);
  });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<number> => {
    if (shuttingDown) return code;
    shuttingDown = true;
    console.log('\nShutting down…');
    await runner.stop();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      await new Promise((r) => child.once('exit', r));
      clearTimeout(killTimer);
    }
    log.end();
    handle.close();
    return code;
  };

  try {
    await waitForHealth(url, child);
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
  if (flags.open !== false && config.server.openBrowser && hasDisplay()) openBrowser(url);

  return new Promise<number>((resolve) => {
    let signals = 0;
    const onSignal = () => {
      signals += 1;
      if (signals > 1) process.exit(ExitCode.Runtime);
      void shutdown(ExitCode.Ok).then(resolve);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    child.once('exit', (code) => {
      if (shuttingDown) return;
      console.error(`The web server exited unexpectedly (code ${code}).`);
      void shutdown(ExitCode.Runtime).then(resolve);
    });
  });
}
