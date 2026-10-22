import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import {
  ConfigError,
  dataDirLayout,
  ensureInstallationId,
  isLoopbackHost,
  loadConfig,
  resolveDataDir,
  type DataDirLayout,
  type DirectiveBenchConfig,
} from '@directivebench/core';
import {
  migrateDatabase,
  openDatabase,
  seedPredefinedCategories,
  type DatabaseHandle,
} from '@directivebench/database';
import { CliError, ExitCode } from './runtime';

export interface Workspace {
  layout: DataDirLayout;
  config: DirectiveBenchConfig;
  handle: DatabaseHandle;
  createdConfig: boolean;
  appliedMigrations: number;
}

/** Runs a config read, turning an invalid `config.json` into a usage error. */
function withConfigErrors(read: () => DirectiveBenchConfig): DirectiveBenchConfig {
  try {
    return read();
  } catch (error) {
    if (error instanceof ConfigError) throw new CliError(error.message, ExitCode.Usage);
    throw error;
  }
}

export function readConfig(layout: DataDirLayout): DirectiveBenchConfig {
  return withConfigErrors(() => loadConfig(layout.config));
}

/**
 * Creates the data directory layout, writes a default config.json (or adds a missing
 * `installationId` to an existing one, SPEC-115 FR-115-15), applies migrations and seeds
 * predefined categories. Idempotent.
 */
export async function initialize(
  dataDirFlag: string | undefined,
  migrationsDir: string,
): Promise<Workspace> {
  const layout = dataDirLayout(resolveDataDir({ flag: dataDirFlag }));
  try {
    for (const dir of [layout.root, layout.fixtures, layout.logs, layout.cache]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    accessSync(layout.root, constants.W_OK);
  } catch (error) {
    throw new CliError(
      `Data directory ${layout.root} is not writable: ${(error as Error).message}`,
      ExitCode.DataDir,
    );
  }
  const createdConfig = !existsSync(layout.config);
  const config = withConfigErrors(() => ensureInstallationId(layout.config));

  let handle: DatabaseHandle;
  let appliedMigrations: number;
  try {
    handle = openDatabase(layout.database);
    appliedMigrations = (await migrateDatabase(handle, migrationsDir)).applied;
    await seedPredefinedCategories(handle.db);
  } catch (error) {
    throw new CliError(
      `Database initialisation failed: ${(error as Error).message}`,
      ExitCode.DataDir,
    );
  }
  return { layout, config, handle, createdConfig, appliedMigrations };
}

export interface ServerOptions {
  host: string;
  port: number;
}

/** Precedence: flag > environment variable > config.json (whose schema supplies the defaults). */
export function resolveServerOptions(
  flags: { host?: string; port?: string; allowNetworkAccess?: boolean },
  config: DirectiveBenchConfig,
  env: NodeJS.ProcessEnv = process.env,
): ServerOptions {
  const host = flags.host ?? env.DIRECTIVEBENCH_HOST ?? config.server.host;
  const rawPort = flags.port ?? env.DIRECTIVEBENCH_PORT ?? String(config.server.port);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`Invalid port "${rawPort}" (expected 1–65535)`, ExitCode.Usage);
  }
  if (!isLoopbackHost(host) && !flags.allowNetworkAccess) {
    throw new CliError(
      `Refusing to listen on non-loopback host "${host}". DirectiveBench has no authentication; pass --allow-network-access to expose it deliberately.`,
      ExitCode.Usage,
    );
  }
  return { host, port };
}
