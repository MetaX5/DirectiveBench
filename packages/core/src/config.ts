import { randomUUID } from 'node:crypto';
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
    /**
     * A random identifier of this data directory, generated once by `ensureInstallationId`. It is
     * the `hostId` in the comparability key of runs that may include this machine's user-level
     * agent configuration (SPEC-115 FR-115-15, SPEC-118 §8.3). Not a secret.
     */
    installationId: z.uuid().optional(),
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

/** The parsed JSON of `config.json`, or undefined when the file does not exist. */
function readConfigJson(configPath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ConfigError(`${configPath} is not valid JSON: ${(error as Error).message}`);
  }
}

function parseConfig(configPath: string, json: unknown): DirectiveBenchConfig {
  const result = configSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(`${configPath} is invalid: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Reads `config.json`; a missing file yields defaults, an invalid file is an error. */
export function loadConfig(configPath: string): DirectiveBenchConfig {
  return parseConfig(configPath, readConfigJson(configPath) ?? {});
}

/** Writes JSON atomically (temp file + rename, mode 0600) so a crash never leaves a partial file. */
function writeConfigFile(configPath: string, value: unknown): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
}

/** Writes `config.json` atomically (temp file + rename) so a crash never leaves a partial file. */
export function saveConfig(configPath: string, config: DirectiveBenchConfig): void {
  writeConfigFile(configPath, configSchema.parse(config));
}

/**
 * Returns the configuration with an `installationId`, generating and storing one when the file
 * has none (SPEC-115 FR-115-15). A missing file is created with every default; an existing file
 * keeps its keys exactly as written and only gains the identifier, so defaults are not frozen
 * into it. An invalid file is an error and is never rewritten (FR-115-11). Two processes adding
 * an identifier at the same moment cannot leave a partial file; the returned value is read back
 * from the file after the write.
 */
export function ensureInstallationId(configPath: string): DirectiveBenchConfig {
  const json = readConfigJson(configPath);
  const config = parseConfig(configPath, json ?? {});
  if (config.installationId) return config;
  const installationId = randomUUID();
  writeConfigFile(
    configPath,
    // A valid existing file is a JSON object: the strict schema accepts nothing else.
    json === undefined ? { ...config, installationId } : { ...(json as object), installationId },
  );
  return loadConfig(configPath);
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
