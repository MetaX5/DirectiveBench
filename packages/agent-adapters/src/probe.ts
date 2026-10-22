import { execFile, type ExecFileException } from 'node:child_process';
import { access, constants, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Read-only status probes of agent CLIs (`--version`, `claude auth status`). A probe runs an
 * absolute executable with argv only (no shell), an allowlisted environment, a fresh empty
 * working directory (so no project configuration of the caller's directory applies), a named
 * timeout and a cap on the output it keeps.
 */

/**
 * Variables a probe inherits from the caller. Everything else — API keys, tokens,
 * `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_*` — is dropped, so a status probe reports the login the
 * user's own configuration provides and never sees a secret.
 */
export const PROBE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  // Windows: profile, temp and shell lookup.
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'SystemRoot',
  'PATHEXT',
  'COMSPEC',
];

/** Builds a probe environment from the allowlist plus `NO_COLOR=1`. */
export function probeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = { NO_COLOR: '1' };
  for (const key of PROBE_ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Finds `name` on `env.PATH` without a shell (honouring `PATHEXT` on Windows). */
export async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here (missing or not executable): try the next candidate.
      }
    }
  }
  return null;
}

export interface ProbeOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Outcome of a probe. `failure` is set when no usable output exists: the timeout elapsed, the
 * output exceeded `maxOutputBytes`, or the process could not start or was killed by a signal.
 * A non-zero exit is not a failure: `claude auth status` exits 1 when nobody is logged in.
 */
export interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  failure: 'timeout' | 'output-limit' | 'failed' | null;
}

function classify(error: ExecFileException | null, stdout: string): ProbeResult {
  if (!error) return { exitCode: 0, stdout, failure: null };
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { exitCode: null, stdout: '', failure: 'output-limit' };
  }
  if (error.killed) return { exitCode: null, stdout: '', failure: 'timeout' };
  if (typeof error.code === 'number') return { exitCode: error.code, stdout, failure: null };
  return { exitCode: null, stdout: '', failure: 'failed' };
}

/** Runs one probe in a fresh empty directory that is removed afterwards. */
export async function runProbe(
  executablePath: string,
  args: readonly string[],
  options: ProbeOptions,
): Promise<ProbeResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'directivebench-probe-'));
  try {
    return await new Promise<ProbeResult>((resolve) => {
      execFile(
        executablePath,
        args,
        {
          cwd,
          // Next.js augments `ProcessEnv` with a required `NODE_ENV`; a probe deliberately does
          // not pass it on, so the allowlisted record is widened to the option's type here.
          env: probeEnv(options.env) as NodeJS.ProcessEnv,
          timeout: options.timeoutMs,
          // On timeout `execFile` destroys the output streams and sends this signal: a status probe
          // has nothing to clean up, and a child ignoring SIGTERM (or a grandchild holding the
          // pipe) must not hang the caller.
          killSignal: 'SIGKILL',
          maxBuffer: options.maxOutputBytes,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout) => resolve(classify(error, stdout)),
      );
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Upper bound on an agent CLI's `--version`. */
export const AGENT_VERSION_TIMEOUT_MS = 5000;

/** Output kept from a `--version` probe. */
export const AGENT_VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

/** Length a stored version line is cut to. */
export const VERSION_LINE_MAX_CHARS = 200;

/** Runs the version command and returns its first non-empty line, or null when it failed. */
export async function readVersionLine(
  executablePath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const probe = await runProbe(executablePath, args, {
    env,
    timeoutMs: AGENT_VERSION_TIMEOUT_MS,
    maxOutputBytes: AGENT_VERSION_MAX_OUTPUT_BYTES,
  });
  if (probe.failure || probe.exitCode !== 0) return null;
  const line = probe.stdout.trim().split('\n')[0]?.trim();
  return line ? line.slice(0, VERSION_LINE_MAX_CHARS) : null;
}
