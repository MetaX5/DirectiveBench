import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4280;
export const DATABASE_FILE = 'directivebench.db';
export const CONFIG_FILE = 'config.json';

export const configSchema = z
  .object({
    configVersion: z.literal(1).default(1),
    server: z
      .object({
        host: z.string().min(1).default(DEFAULT_HOST),
        port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
        openBrowser: z.boolean().default(true),
      })
      .prefault({}),
    runner: z
      .object({
        /** Maximum number of benchmark jobs executed at the same time. */
        concurrency: z.number().int().min(1).max(16).default(1),
        /** Keep temporary workspaces after a run for debugging. */
        keepWorkspaces: z.boolean().default(false),
      })
      .prefault({}),
  })
  .strict();

export type DirectiveBenchConfig = z.infer<typeof configSchema>;

export interface ResolveDataDirOptions {
  /** Explicit `--data-dir` flag value. Highest precedence. */
  flag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * Resolves the persistent data directory. Precedence: flag > DIRECTIVEBENCH_DATA_DIR >
 * OS-specific default. Data never lives inside the npm installation directory.
 */
export function resolveDataDir(options: ResolveDataDirOptions = {}): string {
  const env = options.env ?? process.env;
  if (options.flag) return resolve(/* turbopackIgnore: true */ options.flag);
  if (env.DIRECTIVEBENCH_DATA_DIR)
    return resolve(/* turbopackIgnore: true */ env.DIRECTIVEBENCH_DATA_DIR);
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'directivebench');
    case 'win32':
      return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'directivebench');
    default:
      return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'directivebench');
  }
}

export interface DataDirLayout {
  root: string;
  database: string;
  config: string;
  fixtures: string;
  logs: string;
  cache: string;
}

export function dataDirLayout(root: string): DataDirLayout {
  return {
    root,
    database: join(root, DATABASE_FILE),
    config: join(root, CONFIG_FILE),
    fixtures: join(root, 'fixtures'),
    logs: join(root, 'logs'),
    cache: join(root, 'cache'),
  };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads `config.json`; a missing file yields defaults, an invalid file is an error. */
export function loadConfig(configPath: string): DirectiveBenchConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configSchema.parse({});
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${configPath} is not valid JSON: ${(error as Error).message}`);
  }
  const result = configSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(`${configPath} is invalid: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Writes `config.json` atomically (temp file + rename) so a crash never leaves a partial file. */
export function saveConfig(configPath: string, config: DirectiveBenchConfig): void {
  const validated = configSchema.parse(config);
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
