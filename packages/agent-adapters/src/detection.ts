import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { AgentDetection } from './contract';

/**
 * Descriptor of a real agent harness. Only detection is implemented in this release;
 * execution adapters are specified in `.ai/specs/` (Milestone 4).
 */
export interface CliAgentDescriptor {
  id: string;
  displayName: string;
  executable: string;
  versionArgs: string[];
  specPath: string;
}

export const CLI_AGENTS: readonly CliAgentDescriptor[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    executable: 'claude',
    versionArgs: ['--version'],
    specPath: '.ai/specs/2026-10-14-integration-claude-code.md',
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    executable: 'codex',
    versionArgs: ['--version'],
    specPath: '.ai/specs/2026-10-14-integration-openai-codex.md',
  },
  {
    id: 'cursor',
    displayName: 'Cursor Agent CLI',
    executable: 'cursor-agent',
    versionArgs: ['--version'],
    specPath: '.ai/specs/2026-10-14-integration-cursor.md',
  },
];

async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
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
        // not here
      }
    }
  }
  return null;
}

function runVersion(path: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      path,
      args,
      { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        const line = stdout.trim().split('\n')[0]?.trim();
        resolve(line ? line.slice(0, 200) : null);
      },
    );
  });
}

/**
 * Detects an agent CLI by looking it up on PATH and running its version command. It never
 * reads credential files; authentication readiness is therefore reported as `unknown`.
 */
export async function detectCliAgent(
  descriptor: CliAgentDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentDetection> {
  const executablePath = await findExecutable(descriptor.executable, env);
  if (!executablePath) {
    return {
      adapterId: descriptor.id,
      installed: false,
      version: null,
      executablePath: null,
      auth: 'unknown',
      notes: [`\`${descriptor.executable}\` was not found on PATH.`],
    };
  }
  const version = await runVersion(executablePath, descriptor.versionArgs);
  return {
    adapterId: descriptor.id,
    installed: true,
    version,
    executablePath,
    auth: 'unknown',
    notes: [
      version ? 'Detected on PATH.' : 'Found on PATH but the version command failed.',
      'Benchmark execution through this agent is not implemented yet.',
    ],
  };
}

export async function detectAllCliAgents(env: NodeJS.ProcessEnv = process.env) {
  return Promise.all(
    CLI_AGENTS.map(async (descriptor) => ({
      descriptor,
      detection: await detectCliAgent(descriptor, env),
    })),
  );
}
