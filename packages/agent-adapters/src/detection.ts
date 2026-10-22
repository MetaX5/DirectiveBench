import { CLAUDE_EXECUTABLE, claudeCodeReadiness } from './claude-code-readiness';
import type { AgentDetection, AgentModeReadiness, AuthReadiness } from './contract';
import { findExecutable, readVersionLine } from './probe';

/**
 * Descriptor of a real agent harness. Only detection (and, for Claude Code, readiness) is
 * implemented in this release; execution adapters are specified in `.ai/specs/` (Milestone 4).
 */
export interface CliAgentDescriptor {
  id: string;
  displayName: string;
  executable: string;
  versionArgs: string[];
  specPath: string;
  /** Per-auth-mode readiness check; without one, detection reports `auth: 'unknown'`. */
  readiness?: (
    target: { executablePath: string | null; versionLine: string | null },
    env: NodeJS.ProcessEnv,
  ) => Promise<AgentModeReadiness[]>;
}

export const CLI_AGENTS: readonly CliAgentDescriptor[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    executable: CLAUDE_EXECUTABLE,
    versionArgs: ['--version'],
    specPath: '.ai/specs/2026-10-14-integration-claude-code.md',
    readiness: claudeCodeReadiness,
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

function authFrom(readiness: AgentModeReadiness[] | undefined): AuthReadiness {
  if (!readiness) return 'unknown';
  return readiness.some((mode) => mode.ready) ? 'ready' : 'missing';
}

/**
 * Detects an agent CLI by looking it up on PATH and running its version command, then runs the
 * descriptor's readiness check when it has one. It never reads credential files.
 */
export async function detectCliAgent(
  descriptor: CliAgentDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentDetection> {
  const executablePath = await findExecutable(descriptor.executable, env);
  const versionLine = executablePath
    ? await readVersionLine(executablePath, descriptor.versionArgs, env)
    : null;
  const readiness = await descriptor.readiness?.({ executablePath, versionLine }, env);
  const detection = {
    adapterId: descriptor.id,
    installed: executablePath !== null,
    version: versionLine,
    executablePath,
    auth: authFrom(readiness),
    ...(readiness ? { readiness } : {}),
  };
  if (!executablePath) {
    return { ...detection, notes: [`\`${descriptor.executable}\` was not found on PATH.`] };
  }
  return {
    ...detection,
    notes: [
      versionLine ? 'Detected on PATH.' : 'Found on PATH but the version command failed.',
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
