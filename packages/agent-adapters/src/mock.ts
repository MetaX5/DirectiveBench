import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ArtifactBundle } from '@directivebench/core';
import type {
  AgentAdapter,
  AgentDetection,
  AgentRunRequest,
  AgentRunResult,
  InstalledArtifact,
  TraceEvent,
} from './contract';
import { writeArtifactFiles } from './install';
import { resolveInside } from './paths';
import type { WorkspacePin } from './workspace-pin';

export const MOCK_AGENT_ID = 'mock';
export const MOCK_AGENT_VERSION = '1.0.0';

const playbookStepSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    /** The step runs only if the loaded instruction context contains this phrase (case-insensitive). */
    when: z
      .object({ contextIncludes: z.string().min(1) })
      .strict()
      .optional(),
    write: z.object({ path: z.string().min(1), content: z.string() }).strict(),
  })
  .strict();

export const mockAgentOptionsSchema = z
  .object({
    playbook: z.array(playbookStepSchema).min(1),
  })
  .strict();
export type MockAgentOptions = z.infer<typeof mockAgentOptionsSchema>;

/**
 * Deterministic stand-in for a coding agent. It is NOT an AI and does not measure AI behaviour.
 *
 * Like a real harness it discovers instructions installed in the workspace
 * (`.agents/skills/*\/SKILL.md`, `AGENTS.md`). It then executes the benchmark case's playbook:
 * steps guarded by `when.contextIncludes` only run when the loaded context contains that phrase.
 * Baseline and candidate workspaces therefore diverge exactly when the installed artifact carries
 * the directive — and the resulting files are judged by the real assertions.
 */
export class MockAgentAdapter implements AgentAdapter {
  readonly id = MOCK_AGENT_ID;
  readonly displayName = 'Mock Agent (deterministic, no AI)';
  readonly capabilities = {
    execution: true,
    headless: true,
    modelSelection: false,
    artifactInstallation: true,
    structuredOutput: true,
    usageReporting: false,
    deterministic: true,
  };

  async detect(): Promise<AgentDetection> {
    return {
      adapterId: this.id,
      installed: true,
      version: MOCK_AGENT_VERSION,
      executablePath: null,
      auth: 'not-required',
      notes: ['Built-in deterministic mock; results are not AI evaluations.'],
    };
  }

  async installArtifact(
    workspace: WorkspacePin,
    artifact: ArtifactBundle,
  ): Promise<InstalledArtifact> {
    const workspaceDir = workspace.path;
    const target =
      artifact.type === 'skill'
        ? `.agents/skills/${artifact.slug}`
        : `.agents/instructions/${artifact.slug}`;
    const paths = await writeArtifactFiles(workspaceDir, target, artifact);
    if (artifact.type !== 'skill') {
      // Instructions and rules are surfaced to the mock through AGENTS.md, like an always-on rule.
      const agentsMd = join(workspaceDir, 'AGENTS.md');
      const bodies = artifact.files.map((f) => f.content).join('\n\n');
      const existing = await readFile(agentsMd, 'utf8').catch(() => '');
      await writeFile(agentsMd, `${existing}${existing ? '\n\n' : ''}${bodies}`);
      paths.push('AGENTS.md');
    }
    return { paths };
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const started = performance.now();
    const trace: TraceEvent[] = [];
    const finish = (status: AgentRunResult['status'], summary: string, error: string | null) => ({
      status,
      durationMs: Math.round(performance.now() - started),
      summary,
      trace,
      usage: null,
      error,
    });

    const parsed = mockAgentOptionsSchema.safeParse(request.options);
    if (!parsed.success) {
      const message = `Invalid mock agent options: ${z.prettifyError(parsed.error)}`;
      trace.push({ type: 'error', message });
      return finish('agent-error', 'Mock agent could not start', message);
    }

    const context = await loadInstructionContext(request.workspace.path);
    trace.push({ type: 'context-loaded', files: context.files });
    const haystack = context.text.toLowerCase();

    let applied = 0;
    for (const step of parsed.data.playbook) {
      if (request.signal.aborted) return finish('cancelled', 'Cancelled', null);
      const phrase = step.when?.contextIncludes;
      if (phrase && !haystack.includes(phrase.toLowerCase())) {
        trace.push({
          type: 'step-skipped',
          stepId: step.id,
          description: step.description,
          reason: `instruction context does not contain "${phrase}"`,
        });
        continue;
      }
      try {
        const target = resolveInside(request.workspace.path, step.write.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, step.write.content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace.push({ type: 'error', message });
        return finish('agent-error', `Step ${step.id} failed`, message);
      }
      applied += 1;
      trace.push({ type: 'step-applied', stepId: step.id, description: step.description });
      trace.push({
        type: 'file-written',
        path: step.write.path,
        bytes: Buffer.byteLength(step.write.content),
      });
    }
    const summary = `Applied ${applied} of ${parsed.data.playbook.length} playbook steps`;
    trace.push({ type: 'message', text: summary });
    return finish('completed', summary, null);
  }
}

async function loadInstructionContext(
  workspaceDir: string,
): Promise<{ files: string[]; text: string }> {
  const files: string[] = [];
  const parts: string[] = [];
  const agentsMd = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8').catch(() => null);
  if (agentsMd !== null) {
    files.push('AGENTS.md');
    parts.push(agentsMd);
  }
  const skillsDir = join(workspaceDir, '.agents', 'skills');
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const relative = `.agents/skills/${entry.name}/SKILL.md`;
    const content = await readFile(join(workspaceDir, relative), 'utf8').catch(() => null);
    if (content !== null) {
      files.push(relative);
      parts.push(content);
    }
  }
  return { files, text: parts.join('\n\n') };
}
